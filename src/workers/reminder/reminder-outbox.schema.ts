import { Schema } from 'mongoose';
export const ReminderOutboxSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
    followUpId: { type: Schema.Types.ObjectId, required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    acceptedId: String,
    lastError: String,
  },
  { timestamps: true, collection: 'reminder_outbox' },
);
ReminderOutboxSchema.index({ status: 1, nextAttemptAt: 1 });
