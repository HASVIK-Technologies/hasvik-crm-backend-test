import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ReminderControllerWorker } from './reminder.controller.worker';
import { ReminderServiceWorker } from './reminder.service.worker';
import { NotificationRestClient } from './notification-rest.client';
@Module({
  imports: [ConfigModule],
  providers: [
    ReminderControllerWorker,
    ReminderServiceWorker,
    NotificationRestClient,
  ],
})
export class ReminderModule {}
