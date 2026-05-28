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
import { AdditionalActionDto } from './create-flow.dto';

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

export class UpdateFlowDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(TRIGGER_TYPES)
  triggerType?: string;

  @IsOptional()
  @IsObject()
  triggerConfig?: Record<string, any>;

  @IsOptional()
  @IsIn(ACTION_TYPES)
  actionType?: string;

  @IsOptional()
  @IsObject()
  actionConfig?: Record<string, any>;

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
