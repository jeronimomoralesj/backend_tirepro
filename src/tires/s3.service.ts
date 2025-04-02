import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const region = process.env.AWS_REGION;
const bucketName = process.env.AWS_BUCKET_NAME;
const s3Client = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export async function uploadFileToS3(
  fileBuffer: Buffer,
  fileName: string,
  contentType: string
): Promise<string> {
  const params = {
    Bucket: bucketName,
    Key: fileName,
    Body: fileBuffer,
    ContentType: contentType,
    // Remove ACL because the bucket is configured to enforce bucket ownership.
    // ACL: "public-read" as ObjectCannedACL,
  };

  const command = new PutObjectCommand(params);
  await s3Client.send(command);

  // Return the public URL of the uploaded file.
  return `https://${bucketName}.s3.${region}.amazonaws.com/${fileName}`;
}
