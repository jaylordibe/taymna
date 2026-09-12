import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { OperatorAuthGuard } from '../../common/auth/operator-auth.guard.js';
import { ReportsService, UsageReport } from './reports.service.js';
import { UsageReportQueryDto } from './dto/usage-report-query.dto.js';

@Controller('reports')
@UseGuards(OperatorAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** How long each machine was actually usable during `[from, to)`. */
  @Get('usage')
  usage(@Query() query: UsageReportQueryDto): Promise<UsageReport> {
    return this.reports.usage(query.from, query.to);
  }
}
