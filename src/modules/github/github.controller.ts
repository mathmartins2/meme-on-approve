import { Controller, OnModuleInit } from '@nestjs/common';
import { GithubService } from './github.service';
import { Cron, CronExpression } from '@nestjs/schedule';

@Controller('github')
export class GithubController implements OnModuleInit {
  constructor(private readonly githubService: GithubService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkApprovedPRs() {
    await this.githubService.checkApprovedPRs();
  }

  async onModuleInit() {
    await this.githubService.checkApprovedPRs();
  }
}
