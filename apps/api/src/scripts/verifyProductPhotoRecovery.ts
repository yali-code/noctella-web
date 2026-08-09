import { verifyRemoteProductPhotoBackup } from "../services/productPhotoBackup";

async function main() {
  const manifestKey = process.argv[2];
  if (!manifestKey) { console.error("A product photo backup manifest key is required"); process.exitCode = 1; return; }
  try {
    const result = await verifyRemoteProductPhotoBackup(manifestKey);
    console.log(JSON.stringify(result));
  } catch { console.error("Product photo recovery verification failed"); process.exitCode = 1; }
}
if (require.main === module) void main();
