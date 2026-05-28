import {
  IsString,
  IsOptional,
  IsIn,
  IsObject,
  IsInt,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

const TRIGGER_TYPES = [
  'tire_alert_level',
  'tire_depth_threshold',
  'scheduled_cron',
  'tire_eol_approaching',
  'inspection_completed',
  'tire_rotation',
] as const;

const ACTION_TYPES = [
  'send_email',
  'send_whatsapp',
  'create_calendar_event',
  'make_phone_call',
  'create_notification',
] as const;

export class AdditionalActionDto {
  @IsIn(ACTION_TYPES)
  actionType: string;

  @IsObject()
  actionConfig: Record<string, any>;
}

export class CreateFlowDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsIn(TRIGGER_TYPES)
  triggerType: string;

  @IsObject()
  triggerConfig: Record<string, any>;

  @IsIn(ACTION_TYPES)
  actionType: string;

  @IsObject()
  actionConfig: Record<string, any>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => AdditionalActionDto)
  additionalActions?: AdditionalActionDto[];

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
