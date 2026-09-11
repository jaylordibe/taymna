import { IsInt, Max, Min } from 'class-validator';

export class ExtendSessionDto {
  @IsInt()
  @Min(1)
  @Max(10_080)
  additionalMinutes!: number;
}
