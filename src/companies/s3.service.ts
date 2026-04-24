import { Injectable, InternalServerErrorException, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

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
        accessKeyId: this.config.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.config.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
      },
    });
  }

  private validateImage(buffer: Buffer): void {
    const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
    const isPng  = buffer[0] === 0x89 && buffer[1] === 0x50;
    const isWebp = buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';

    if (!isJpeg && !isPng && !isWebp) {
      throw new BadRequestException('Invalid image format. Only JPEG, PNG, and WebP are allowed.');
    }
    if (buffer.length > 5 * 1024 * 1024) {
      throw new BadRequestException('Image too large. Maximum size is 5MB.');
    }
  }

  async uploadCompanyLogo(
    buffer: Buffer,
    companyId: string,
    contentType: string,
  ): Promise<string> {
    this.validateImage(buffer);
    const ext = contentType.split('/')[1] ?? 'jpg';
    const key = `profilepics/${companyId}-${Date.now()}.${ext}`;

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        }),
      );
    } catch (err) {
      this.logger.error(`S3 upload failed for company ${companyId}`, err);
      throw new InternalServerErrorException('Failed to upload image');
    }

    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  async uploadMarketplaceImage(
    buffer: Buffer,
    distributorId: string,
    contentType: string,
  ): Promise<string> {
    this.validateImage(buffer);
    const ext = contentType.split('/')[1] ?? 'jpg';
    const key = `marketplace/${distributorId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        }),
      );
    } catch (err) {
      this.logger.error(`S3 marketplace upload failed`, err);
      throw new InternalServerErrorException('Failed to upload image');
    }

    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  private validateVideo(buffer: Buffer, mime: string | undefined): void {
    // 50 MB cap — enough for a 1-2 min instructional clip at reasonable
    // quality, small enough that S3 upload fits in one request and the
    // dist's customer can actually download it over mobile data.
    if (buffer.length > 50 * 1024 * 1024) {
      throw new BadRequestException('El video es demasiado grande. Máximo 50 MB.');
    }
    const allowed = new Set([
      'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska',
    ]);
    if (!mime || !allowed.has(mime.toLowerCase())) {
      throw new BadRequestException('Formato de video no soportado. Usa MP4, MOV o WebM.');
    }
  }

  async uploadCatalogVideo(
    buffer: Buffer,
    companyId: string,
    catalogId: string,
    contentType: string,
  ): Promise<string> {
    this.validateVideo(buffer, contentType);
    const ext = (contentType.split('/')[1] ?? 'mp4').replace('quicktime', 'mov').replace('x-matroska', 'mkv');
    const key = `catalog-videos/${companyId}/${catalogId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        }),
      );
    } catch (err) {
      this.logger.error(`S3 catalog video upload failed`, err);
      throw new InternalServerErrorException('Failed to upload video');
    }

    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  /**
   * Verify a URL belongs to AWS S3. Used by the asset-proxy route so a
   * signed-in user can fetch their catalog uploads via the API, avoiding
   * browser CORS on the bucket.
   *
   * Permissive on purpose: accept any `*.amazonaws.com` hostname. S3
   * supports at least four URL styles (virtual-hosted regional, legacy
   * us-east-1, path-style, legacy regional) and the exact AWS_REGION /
   * AWS_BUCKET_NAME env may not match the URL byte-for-byte. The endpoint
   * is already authenticated + gated to distribuidor plans, so allowing
   * fetch of any amazonaws.com host is not an SSRF risk for us (internal
   * metadata is at 169.254.169.254, not amazonaws.com).
   */
  isOwnBucketUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && u.hostname.endsWith('.amazonaws.com');
    } catch {
      return false;
    }
  }

  async uploadCatalogImage(
    buffer: Buffer,
    companyId: string,
    catalogId: string,
    contentType: string,
  ): Promise<string> {
    this.validateImage(buffer);
    const ext = contentType.split('/')[1] ?? 'jpg';
    const key = `catalog/${companyId}/${catalogId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        }),
      );
    } catch (err) {
      this.logger.error(`S3 catalog upload failed`, err);
      throw new InternalServerErrorException('Failed to upload image');
    }

    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      // Log but don't throw — stale S3 objects are not critical
      this.logger.warn(`S3 delete failed for key ${key}`, err);
    }
  }
}