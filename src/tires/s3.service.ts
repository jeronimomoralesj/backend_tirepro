import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(private readonly config: ConfigService) {
    this.region = this.config.getOrThrow<string>('AWS_REGION');
    this.bucket = this.config.getOrThrow<string>('AWS_BUCKET_NAME');

    this.s3 = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId:     this.config.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.config.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
      },
    });
  }

  async uploadInspectionImage(
    buffer: Buffer,
    tireId: string,
    contentType: string,
  ): Promise<string> {
    const ext = contentType.split('/')[1] ?? 'jpg';
    const key = `tire-inspections/${tireId}-${Date.now()}.${ext}`;
    return this.upload(buffer, key, contentType);
  }

  async uploadBulkFile(buffer: Buffer, companyId: string): Promise<string> {
    const key = `bulk-uploads/${companyId}-${Date.now()}.xlsx`;
    return this.upload(buffer, key, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  private async upload(buffer: Buffer, key: string, contentType: string): Promise<string> {
    try {
      await this.s3.send(new PutObjectCommand({
        Bucket:      this.bucket,
        Key:         key,
        Body:        buffer,
        ContentType: contentType,
      }));
    } catch (err) {
      this.logger.error(`S3 upload failed for key ${key}`, err);
      throw new InternalServerErrorException('Failed to upload file to S3');
    }

    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }
}