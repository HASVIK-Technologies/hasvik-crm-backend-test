import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReminderServiceWorker } from './reminder.service.worker';

@Injectable()
export class ReminderControllerWorker {
  private readonly logger = new Logger(ReminderControllerWorker.name);

  constructor(private readonly reminderService: ReminderServiceWorker) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkReminders(): Promise<void> {
    this.logger.log('Checking reminders...');
    await this.reminderService.checkReminders();
  }
}
