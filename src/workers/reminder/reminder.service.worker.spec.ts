import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { NotificationRestClient } from './notification-rest.client';
jest.mock('axios');
describe('NotificationRestClient', () => {
  const config = {
    get: (key: string) =>
      (
        ({
          NOTIFICATION_SERVICE_URL: 'https://notifications.example',
          NOTIFICATION_SERVICE_TOKEN: 'test-token',
        }) as Record<string, string>
      )[key],
  } as ConfigService;
  it('submits reminders as an authenticated batch', async () => {
    const response = { results: [{ index: 0, ok: true, id: 'n1' }] };
    (axios.post as jest.Mock).mockResolvedValue({ data: response });
    const input = [
      {
        tenantId: '507f1f77bcf86cd799439011',
        channel: 'whatsapp' as const,
        category: 'reminder' as const,
        recipient: '919999999999',
        templateCode: 'REMINDER',
        variables: {},
        idempotencyKey: 'test-key',
      },
    ];
    await expect(
      new NotificationRestClient(config).sendBulk(input),
    ).resolves.toEqual(response.results);
    expect(axios.post).toHaveBeenCalledWith(
      'https://notifications.example/internal/v1/notifications/bulk',
      { notifications: input },
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });
  it('rejects incomplete bulk responses so requests can retry', async () => {
    (axios.post as jest.Mock).mockResolvedValue({ data: { results: [] } });
    await expect(
      new NotificationRestClient(config).sendBulk([
        {
          tenantId: '507f1f77bcf86cd799439011',
          channel: 'whatsapp',
          category: 'reminder',
          recipient: '919999999999',
          templateCode: 'REMINDER',
          variables: {},
          idempotencyKey: 'test-key',
        },
      ]),
    ).rejects.toThrow('Incomplete');
  });
});
