import { PartialType } from '@nestjs/mapped-types';
import { CreateExtraDto } from './create-extra.dto';

export class UpdateExtraDto extends PartialType(CreateExtraDto) {}
