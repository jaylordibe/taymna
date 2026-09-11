import { IsEnum, IsString, Length } from 'class-validator';
import { $Enums } from '../../generated/prisma/client.js';

export class CreateMachineDto {
  @IsString()
  @Length(1, 100)
  name!: string;

  @IsEnum($Enums.Platform)
  platform!: $Enums.Platform;
}
