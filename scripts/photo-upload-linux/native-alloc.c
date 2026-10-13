/* Offline glibc-only diagnostic. Never linked or preloaded into the API image entry point.
 * Logs >=1MiB allocation lifetimes/stacks; SMALL allocations and mmap are NOT traced.
 * Diagnostic perturbation is unavoidable: use separate uninstrumented acceptance trials.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <execinfo.h>
#include <fcntl.h>
#include <malloc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
extern void *__libc_malloc(size_t);
extern void *__libc_calloc(size_t,size_t);
extern void *__libc_realloc(void *,size_t);
extern void __libc_free(void *);
static __thread int busy;
static int fd=-1;
static unsigned sequence;
#define THRESHOLD (1024u*1024u)
#define MAX_EVENTS 2048u
__attribute__((constructor)) static void initialize(void) {
  if (getenv("NOCTELLA_NATIVE_TRACE") && strcmp(getenv("NOCTELLA_NATIVE_TRACE"),"synthetic-only")==0)
    fd=open("/evidence/native-alloc.ndjson",O_WRONLY|O_CREAT|O_EXCL|O_APPEND|O_CLOEXEC,0600);
}
static void record(const char *kind,void *pointer,size_t size,void *old) {
  if(fd<0||busy||size<THRESHOLD)return;
  busy=1; unsigned seq=__atomic_fetch_add(&sequence,1,__ATOMIC_RELAXED);
  if(seq>=MAX_EVENTS){busy=0;return;}
  struct timespec t;clock_gettime(CLOCK_REALTIME,&t);
  char line[4096];int n=snprintf(line,sizeof(line),"{\"event\":\"%s\",\"seq\":%u,\"time\":%lld,\"pid\":%d,\"tid\":%ld,\"ptr\":\"%p\",\"old\":\"%p\",\"bytes\":%zu,\"frames\":[",kind,seq,(long long)t.tv_sec*1000+t.tv_nsec/1000000,getpid(),syscall(SYS_gettid),pointer,old,size);
  void *frames[16];int count=backtrace(frames,16);
  for(int i=2;i<count&&n<(int)sizeof(line)-260;i++){
    Dl_info info;memset(&info,0,sizeof(info));dladdr(frames[i],&info);
    const char *file=info.dli_fname?strrchr(info.dli_fname,'/'):NULL;
    file=file?file+1:(info.dli_fname?info.dli_fname:"unknown");
    n+=snprintf(line+n,sizeof(line)-n,"%s{\"dso\":\"%.100s\",\"offset\":\"%lx\",\"symbol\":\"%.100s\"}",i==2?"":",",file,(unsigned long)((uintptr_t)frames[i]-(uintptr_t)info.dli_fbase),info.dli_sname?info.dli_sname:"");
  }
  n+=snprintf(line+n,sizeof(line)-n,"]}\n");
  if(n>0&&n<(int)sizeof(line)) { ssize_t result=write(fd,line,(size_t)n);(void)result; }
  busy=0;
}
void *malloc(size_t size){void *p=__libc_malloc(size);record("malloc",p,size,NULL);return p;}
void *calloc(size_t count,size_t size){void *p=__libc_calloc(count,size);if(!size||count<=SIZE_MAX/size)record("calloc",p,count*size,NULL);return p;}
void *realloc(void *old,size_t size){size_t previous=old?malloc_usable_size(old):0;void *p=__libc_realloc(old,size);if(p||!size){record("realloc.free",old,previous,NULL);record("realloc",p,size,old);}return p;}
void free(void *p){if(p)record("free",p,malloc_usable_size(p),NULL);__libc_free(p);}
