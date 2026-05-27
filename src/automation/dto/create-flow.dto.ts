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

export class CreateFlowDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(TriggerType)
  triggerType: TriggerType;

  @IsObject()
  triggerConfig: Prisma.InputJsonValue;

  @IsEnum(ActionType)
  actionType: ActionType;

  @IsObject()
  actionConfig: Prisma.InputJsonValue;

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
