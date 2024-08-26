import { Module } from '@nestjs/common';
import { GithubModule } from './modules/github/github.module';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [ScheduleModule.forRoot(), ConfigModule.forRoot(), GithubModule],
})
export class AppModule {}
