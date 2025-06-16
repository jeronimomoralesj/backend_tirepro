
import { 
  IsString, 
  IsNotEmpty, 
  MaxLength 
} from 'class-validator';

export class CreateChatDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100, { message: 'title must be at most 100 characters' })
  title: string;

  @IsString()
  @IsNotEmpty()
  // Optionally replace with @IsIn([...]) if you have a fixed set of categories
  category: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000, { message: 'content must be at most 1000 characters' })
  content: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2, { message: 'emoji must be a single emoji character' })
  emoji: string;
}
