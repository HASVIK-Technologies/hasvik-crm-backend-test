import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import moment from 'moment-timezone';
import mongoose, { Model, Types } from 'mongoose';
import { Business, ContactNumber, FollowUp } from '../../mongo/interfaces';
import { FollowUpStatus } from '../../mongo/enums';
import { MongoService } from '../../mongo/mongo.service';
import { ReminderOutboxSchema } from './reminder-outbox.schema';
import {
  NotificationRestClient,
  ReminderRequest,
} from './notification-rest.client';

const DEFAULT_REMINDER_TEMPLATE_CODE = 'BUSINESS_FOLLOWUP_WITH_IMAGE';
const DEFAULT_REMINDER_HEADER_IMAGE_URL =
  'https://hasvik.s3.ap-south-1.amazonaws.com/crm/logo/hasvik-reminder.jpeg';
const DEFAULT_REMINDER_BUSINESS_NAME = 'HASVIK Tech';
type ReminderBusiness = Pick<
  Business,
  'name' | 'phoneNumbers' | 'whatsappNumbers'
>;
type FollowUpWithBusiness = Omit<FollowUp, 'businessId' | 'assignedTo'> & {
  businessId: ReminderBusiness | null;
  assignedTo: { fullName: string; phoneNumber?: string } | null;
};
interface OutboxRecord {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  followUpId: Types.ObjectId;
  idempotencyKey: string;
  payload: ReminderRequest;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError?: string;
  acceptedId?: string;
}

@Injectable()
export class ReminderServiceWorker {
  private readonly logger = new Logger(ReminderServiceWorker.name);
  private isRunning = false;
  constructor(
    private readonly mongo: MongoService,
    private readonly client: NotificationRestClient,
    private readonly configService: ConfigService,
  ) {}
  private outbox(): Model<OutboxRecord> {
    return mongoose.connection.model<OutboxRecord>(
      'ReminderOutbox',
      ReminderOutboxSchema,
    );
  }

  async checkReminders(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Previous reminder run still active');
      return;
    }
    this.isRunning = true;
    try {
      await this.collectDueReminders();
      await this.flushOutbox();
    } finally {
      this.isRunning = false;
    }
  }

  private async collectDueReminders(): Promise<void> {
    const now = new Date();
    const lookbackDays = Math.max(
      1,
      Number(this.configService.get('REMINDER_LOOKBACK_DAYS') || 30),
    );
    const earliest = new Date(now.getTime() - lookbackDays * 86400000);

    const reminderTime = {
      $subtract: ['$scheduledAt', { $multiply: ['$reminderInMinutes', 60000] }],
    };

    const followUps = (await this.mongo.models.followUp
      .find({
        status: FollowUpStatus.SCHEDULED,
        reminderInMinutes: { $gte: 0 },
        $expr: {
          $and: [
            { $lte: [reminderTime, now] },
            { $gte: [reminderTime, earliest] },
          ],
        },
      })
      .populate<{ businessId: ReminderBusiness | null }>(
        'businessId',
        'name phoneNumbers whatsappNumbers',
      )
      .populate<{
        assignedTo: { fullName: string; phoneNumber?: string } | null;
      }>('assignedTo', 'fullName phoneNumber')
      .exec()) as FollowUpWithBusiness[];

    for (const followUp of followUps) {
      const payload = this.buildPayload(followUp);
      if (!payload) continue;
      await this.outbox().updateOne(
        { idempotencyKey: payload.idempotencyKey },
        {
          $setOnInsert: {
            tenantId: this.mongo.toObjectId(payload.tenantId),
            followUpId: followUp._id,
            payload,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }

  private buildPayload(followUp: FollowUpWithBusiness): ReminderRequest | null {
    const followUpId = followUp._id.toString();
    const business = followUp.businessId;
    const assignedTo = followUp.assignedTo;
    if (!business || !assignedTo?.phoneNumber) {
      this.logger.warn(
        `Reminder ${followUpId} missing business or recipient; needs correction`,
      );
      return null;
    }
    const businessContacts: ContactNumber[] = [
      ...(business.whatsappNumbers ?? []),
      ...(business.phoneNumbers ?? []),
    ];
    const primaryContact =
      businessContacts.find((c) => c.isPrimary) ?? businessContacts[0];
    return {
      tenantId: followUp.tenantId.toString(),
      channel: 'whatsapp',
      category: 'reminder',
      recipient: assignedTo.phoneNumber,
      templateCode:
        this.configService.get<string>('REMINDER_WHATSAPP_TEMPLATE_CODE') ||
        DEFAULT_REMINDER_TEMPLATE_CODE,
      variables: {
        headerImageUrl:
          this.configService.get<string>(
            'REMINDER_WHATSAPP_HEADER_IMAGE_URL',
          ) || DEFAULT_REMINDER_HEADER_IMAGE_URL,
        customerName: assignedTo.fullName || 'Admin',
        businessName:
          this.configService.get<string>('REMINDER_WHATSAPP_BUSINESS_NAME') ||
          DEFAULT_REMINDER_BUSINESS_NAME,
        businessDisplayName: business.name,
        contactPerson: primaryContact?.name || business.name,
        phoneNumber: primaryContact?.number || assignedTo.phoneNumber,
        followUpDate: moment.utc(followUp.scheduledAt).format('DD MMM YYYY'),
        followUpTime: moment.utc(followUp.scheduledAt).format('hh:mm A'),
        purpose: 'Followup Reminder',
        assignedTo: assignedTo.fullName || 'Your team',
      },
      idempotencyKey: `follow-up-reminder:${followUpId}:${followUp.scheduledAt.getTime()}`,
    };
  }

  private async flushOutbox(): Promise<void> {
    const batchSize = Math.min(
      100,
      Math.max(1, Number(this.configService.get('REMINDER_BATCH_SIZE') || 50)),
    );
    // Pending records survive process restarts and are never deleted on transport failure.
    for (let page = 0; page < 100; page++) {
      const pending = await this.outbox()
        .find({ status: 'pending', nextAttemptAt: { $lte: new Date() } })
        .sort({ createdAt: 1 })
        .limit(batchSize)
        .lean();
      if (!pending.length) break;
      try {
        const results = await this.client.sendBulk(
          pending.map((x) => x.payload),
        );
        for (const result of results) {
          const record = pending[result.index];
          if (!record) {
            continue;
          }

          if (result.ok) {
            await this.outbox().updateOne(
              { _id: record._id },
              {
                $set: {
                  status: 'accepted',
                  acceptedId: result.id,
                  lastError: null,
                },
              },
            );
          } else {
            await this.scheduleRetry(
              record,
              result.error || 'Rejected by notification service',
            );
          }
        }
      } catch (e) {
        for (const record of pending)
          await this.scheduleRetry(
            record,
            e instanceof Error ? e.message : String(e),
          );
        break;
      }
    }
  }

  private async scheduleRetry(record: OutboxRecord, error: string) {
    const attempts = record.attempts + 1;
    const delay = Math.min(
      3600000,
      30000 * Math.pow(2, Math.min(attempts - 1, 7)),
    );
    await this.outbox().updateOne(
      { _id: record._id },
      {
        $set: {
          status: 'pending',
          attempts,
          nextAttemptAt: new Date(Date.now() + delay),
          lastError: error,
        },
      },
    );
    this.logger.warn(
      `Reminder ${record.idempotencyKey} pending retry: ${error}`,
    );
  }
}
