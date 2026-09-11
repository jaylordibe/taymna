import { IsString } from 'class-validator';

export class EnrollDto {
  @IsString()
  token!: string;
}
