import {
  IsString,
  IsOptional,
  IsEnum,
  IsObject,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { TriggerType, ActionType, Prisma } from '@prisma/client';

export class UpdateFlowDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(TriggerType)
  triggerType?: TriggerType;

  @IsOptional()
  @IsObject()
  triggerConfig?: Prisma.InputJsonValue;

  @IsOptional()
  @IsEnum(ActionType)
  actionType?: ActionType;

  @IsOptional()
  @IsObject()
  actionConfig?: Prisma.InputJsonValue;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  cooldownMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxRunsPerDay?: number;
}
