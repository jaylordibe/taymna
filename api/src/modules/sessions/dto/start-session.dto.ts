import { IsInt, Max, Min } from 'class-validator';

export class StartSessionDto {
  /** Cap of 7 days keeps a fat-fingered duration from locking a machine in for a year. */
  @IsInt()
  @Min(1)
  @Max(10_080)
  durationMinutes!: number;
}
