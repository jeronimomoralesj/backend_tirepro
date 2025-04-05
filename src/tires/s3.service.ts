// src/tires/s3.service.ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { BadRequestException } from '@nestjs/common';

const region = process.env.AWS_REGION;
const bucketName = process.env.AWS_BUCKET_NAME;

// Check that bucketName is defined
if (!bucketName) {
  throw new BadRequestException("AWS_BUCKET_NAME is not configured");
}

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
  };

  const command = new PutObjectCommand(params);
  await s3Client.send(command);

  // Return the public URL of the uploaded file.
  return `https://${bucketName}.s3.${region}.amazonaws.com/${fileName}`;
}
