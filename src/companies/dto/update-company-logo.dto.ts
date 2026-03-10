import { IsString, IsNotEmpty, Matches } from 'class-validator';

export class UpdateCompanyLogoDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^data:image\/(jpeg|png|webp);base64,/, {
    message: 'imageBase64 must be a valid base64-encoded JPEG, PNG, or WebP image',
  })
  imageBase64: string;
}