import { IsString, Length } from 'class-validator';

export class UpdateMachineDto {
  @IsString()
  @Length(1, 100)
  name!: string;
}
