import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Fault injection exists only in this compiled test translation unit, never in the packaged helper.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "noctella-uuid-abi-"));
const source = path.resolve(__dirname, "../../../scripts/photo-publication-capability/landlock-worker.c");
const baseline = path.resolve(__dirname, "../../../docs/engineering/f2-uuid-compatibility-evidence/baseline-landlock-worker.c.txt");
const expected = "0102030405060708090a0b0c0d0e0f10\n";
const transcript: unknown[] = [];
function build(input: string, name: string) {
  const wrapper = path.join(root, name + ".c"), binary = path.join(root, name);
  fs.writeFileSync(wrapper, `
#define _GNU_SOURCE
#include <stdarg.h>
#include <sys/ioctl.h>
#include <sys/vfs.h>
#include <errno.h>
#include <string.h>
#include <stdint.h>
static const char *scenario;
static int calls;
static int test_ioctl(int fd, unsigned long request, ...);
int test_fstatfs(int fd, struct statfs *st);
#define ioctl test_ioctl
#define fstatfs test_fstatfs
#define main worker_main
#include ${JSON.stringify(input)}
#undef main
#undef ioctl
#undef fstatfs
int test_fstatfs(int fd, struct statfs *st) {
    if (!strcmp(scenario,"native-ext4")) return fstatfs(fd,st);
    if (!strcmp(scenario,"statfs-failure")) { errno=EIO; return -1; }
    memset(st,0,sizeof(*st)); st->f_type=!strcmp(scenario,"unsupported-fs") ? 0x01021994 : 0xef53;
    return 0;
}
static int test_ioctl(int fd, unsigned long request, ...) {
    va_list args; va_start(args,request); void *out=va_arg(args,void *); va_end(args); ++calls;
    if (request == 0x80111500UL) {
        if (!strcmp(scenario,"generic")) { unsigned char *p=out; p[0]=16; for(int i=0;i<16;i++) p[i+1]=i+1; return 0; }
        if (!strcmp(scenario,"generic-malformed")) { ((unsigned char *)out)[0]=15; return 0; }
        errno=!strcmp(scenario,"permission") ? EPERM : !strcmp(scenario,"access") ? EACCES : !strcmp(scenario,"io-failure") ? EIO : ENOTTY;
        return -1;
    }
    if (request != 0x8008662cUL) { errno=EINVAL; return -1; }
    if (!strcmp(scenario,"native-ext4")) return ioctl(fd,request,out);
    if (!strcmp(scenario,"legacy-unsupported")) { errno=ENOTTY; return -1; }
    if (!strcmp(scenario,"legacy-permission")) { errno=EPERM; return -1; }
    struct { uint32_t len, flags; unsigned char uuid[16]; } *p=out;
    if (p->len != 16 || p->flags != 0) { errno=EINVAL; return -1; }
    p->len=!strcmp(scenario,"legacy-malformed") ? 15 : 16;
    p->flags=!strcmp(scenario,"legacy-flags") ? 1 : 0;
    for(int i=0;i<16;i++) p->uuid[i]=!strcmp(scenario,"legacy-zero") ? 0 : i+1;
    return 0;
}
int main(int argc, char **argv) {
    if(argc!=2) return 126;
    scenario=argv[1]; int result=storage_proof(); fprintf(stderr,"ioctl_calls=%d\\n",calls); return result;
}
`);
  const compile = spawnSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", wrapper, "-o", binary], { encoding: "utf8" });
  expect(compile.status, compile.stderr).toBe(0);
  return binary;
}
let current: string, previous: string;
function run(binary: string, scenario: string, file: string) {
  const padding = Array.from({ length: 8 }, () => fs.openSync(file, "r"));
  const fd = fs.openSync(file, "r"); expect(fd).toBeGreaterThan(3);
  try {
    const result = spawnSync(binary, [scenario], { stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8" });
    transcript.push({ binary: path.basename(binary), scenario, parentFd: fd, childFd: 3, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
    return result;
  } finally { fs.closeSync(fd); padding.forEach(value => fs.closeSync(value)); }
}
afterAll(() => {
  const evidence = process.env.PHOTO_REMOUNT_EVIDENCE_DIR;
  if (evidence && transcript.length) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "uuid-abi-native.json"), JSON.stringify({ platform: process.platform, kernel: os.release(), uid: process.getuid?.(), sourceSha256: createHash("sha256").update(fs.readFileSync(source)).digest("hex"), baselineSha256: createHash("sha256").update(fs.readFileSync(baseline)).digest("hex"), targetAcceptance: "NOT_EXECUTED", transcript }, null, 2)); }
  fs.rmSync(root, { recursive: true, force: true });
});
describe.runIf(process.platform === "linux")("descriptor UUID ABI compatibility (test-only syscall injection)", () => {
  beforeAll(() => { expect(process.getuid!()).not.toBe(0); current = build(source, "current"); previous = build(baseline, "baseline"); });
  it("reproduces generic ENOTTY before and succeeds after with the same full ext4 UUID", () => {
    const file=path.join(root,"synthetic");fs.writeFileSync(file,"synthetic");
    const before=run(previous,"ext4",file), after=run(current,"ext4",file);
    expect(before.status).toBe(125);expect(before.stdout).toBe("");expect(after.status).toBe(0);expect(after.stdout).toBe(expected);expect(after.stderr).toBe("ioctl_calls=2\n");
    const generic=run(current,"generic",file);expect(generic.status).toBe(0);expect(generic.stdout).toBe(after.stdout);expect(generic.stderr).toBe("ioctl_calls=1\n");
    const directory=run(current,"ext4",root);expect(directory.status).toBe(0);expect(directory.stdout).toBe(expected);
  });
  for (const scenario of ["permission", "access", "io-failure", "generic-malformed", "unsupported-fs", "statfs-failure", "legacy-unsupported", "legacy-permission", "legacy-malformed", "legacy-flags", "legacy-zero"]) it("fails closed: " + scenario, () => {
    const result=run(current,scenario,root);expect(result.status).toBe(125);expect(result.stdout).toBe("");
    expect(result.stderr).toBe("ioctl_calls=" + (scenario.startsWith("legacy-") ? 2 : 1) + "\n");
  });
  it.runIf(Boolean(process.env.F2_UUID_EXT4_ROOT))("real unprivileged ext4 UUID ioctl on file and directory, generic ENOTTY injected only", () => {
    const storage=process.env.F2_UUID_EXT4_ROOT!;expect(fs.statfsSync(storage).type).toBe(0xef53);
    const file=path.join(storage,"uuid-synthetic-"+process.pid);fs.writeFileSync(file,"synthetic-uuid-compatibility");
    try {
      const before=run(previous,"native-ext4",file);expect(before.status).toBe(125);expect(before.stdout).toBe("");
      const directory=run(current,"native-ext4",storage), regular=run(current,"native-ext4",file);
      expect(directory.status,directory.stderr).toBe(0);expect(regular.status,regular.stderr).toBe(0);
      expect(directory.stdout).toMatch(/^[0-9a-f]{32}\n$/);expect(directory.stdout).not.toBe("0".repeat(32)+"\n");expect(regular.stdout).toBe(directory.stdout);
      const helper=process.env.F2_CAPABILITY_LAUNCHER!;expect(helper).toBeTruthy();
      const packaged=run(helper,"--storage-proof",file);expect(packaged.status,packaged.stderr).toBe(0);expect(packaged.stdout).toBe(regular.stdout);
      expect(fs.readFileSync(file,"utf8")).toBe("synthetic-uuid-compatibility");
    } finally { fs.unlinkSync(file); }
  });
});
