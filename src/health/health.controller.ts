import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthService, HealthStatus } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // Render polls this; throttling it could take a healthy instance out of service.
  @Get()
  @SkipThrottle()
  @ApiOperation({
    summary: 'Liveness and database check (Render healthCheckPath)',
    description: '200 { status: "ok", db: "ok" }, or 503 DB_UNAVAILABLE.',
  })
  check(): Promise<HealthStatus> {
    return this.health.check();
  }
}
