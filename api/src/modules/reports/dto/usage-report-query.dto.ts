import { IsISO8601 } from 'class-validator';

export class UsageReportQueryDto {
  /**
   * Start of the reported window, inclusive, as an absolute instant.
   *
   * The dashboard sends instants rather than calendar dates on purpose: it
   * already knows the operator's timezone, so "12 September" becomes local
   * midnight to local midnight in the browser and the server never has to
   * guess a timezone (or get DST wrong) to decide which day a session
   * belongs to.
   */
  @IsISO8601()
  from!: string;

  /** End of the window, exclusive. */
  @IsISO8601()
  to!: string;
}
