import { IsString, IsEmail, IsNotEmpty, IsOptional, IsArray, IsUUID } from 'class-validator';

export class CreateUserDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsNotEmpty()
  @IsString()
  password: string;

  @IsNotEmpty()
  @IsString()
  companyId: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  preferredLanguage?: string;

  // Optional vehicle scoping. When provided and non-empty, the new user is
  // restricted to inspecting only these vehicles via UserVehicleAccess; an
  // empty/omitted array keeps the current behavior (full company scope).
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  vehicleIds?: string[];

  // Distribuidor-side per-user scoping. Each id is a Company linked to the
  // admin's distribuidor via DistributorAccess. The user can inspect any
  // vehicle belonging to any of these clients, via UserClientAccess. Empty
  // or omitted preserves the existing "all clients in reach" default.
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  clientIds?: string[];
}