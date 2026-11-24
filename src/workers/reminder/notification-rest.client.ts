import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
export interface ReminderRequest {
  tenantId: string;
  channel: 'whatsapp';
  category: 'reminder';
  recipient: string;
  templateCode: string;
  variables: Record<string, string>;
  idempotencyKey: string;
}
export interface ReminderResponse {
  index: number;
  ok: boolean;
  id?: string;
  status?: string;
  duplicate?: boolean;
  error?: string;
}
@Injectable()
export class NotificationRestClient {
  constructor(private readonly config: ConfigService) {}
  async sendBulk(
    notifications: ReminderRequest[],
  ): Promise<ReminderResponse[]> {
    const url = this.config.get<string>('NOTIFICATION_SERVICE_URL');
    const token = this.config.get<string>('NOTIFICATION_SERVICE_TOKEN');
    if (!url || !token)
      throw new ServiceUnavailableException(
        'Notification service REST configuration missing',
      );
    const response = await axios.post<{ results: ReminderResponse[] }>(
      `${url.replace(/\/$/, '')}/internal/v1/notifications/bulk`,
      { notifications },
      { timeout: 10000, headers: { Authorization: `Bearer ${token}` } },
    );
    if (
      !Array.isArray(response.data.results) ||
      response.data.results.length !== notifications.length ||
      new Set(response.data.results.map((r) => r.index)).size !==
        notifications.length ||
      response.data.results.some(
        (r) =>
          !Number.isInteger(r.index) ||
          r.index < 0 ||
          r.index >= notifications.length ||
          typeof r.ok !== 'boolean',
      )
    )
      throw new Error('Incomplete notification bulk response');
    return response.data.results;
  }
}
