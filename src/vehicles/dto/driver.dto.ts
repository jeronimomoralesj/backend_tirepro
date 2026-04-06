import { IsString, IsNotEmpty, IsOptional, IsBoolean, MaxLength, Allow } from 'class-validator';

export class DriverDto {
  // Allow DB fields to pass through validation without error
  // (frontend sends full driver objects including these)
  @IsOptional()
  @Allow()
  id?: string;

  @IsOptional()
  @Allow()
  vehicleId?: string;

  @IsOptional()
  @Allow()
  createdAt?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nombre: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  telefono: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
