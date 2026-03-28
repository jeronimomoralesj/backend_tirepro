import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  private readonly phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
  private readonly accessToken   = process.env.WHATSAPP_ACCESS_TOKEN ?? '';
  private readonly templateName  = 'driver_tire_alert_';
  private readonly apiUrl: string;

  constructor() {
    this.apiUrl = `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`;
  }

  /**
   * Send a driver alert via WhatsApp template message.
   *
   * @param to          Driver phone number in international format (e.g. "573151349122")
   * @param vehiclePlaca  Vehicle plate (e.g. "ABC123")
   * @param position      Tire position (e.g. "3")
   * @param action        What the driver needs to do
   * @param confirmLink   Full confirmation URL
   */
  async sendDriverAlert(
    to: string,
    vehiclePlaca: string,
    position: string,
    action: string,
    confirmLink: string,
  ): Promise<boolean> {
    if (!this.phoneNumberId || !this.accessToken) {
      this.logger.warn('WhatsApp credentials not configured — skipping message');
      return false;
    }

    // Normalize phone: remove spaces, dashes, plus. Ensure country code.
    let phone = to.replace(/[\s\-\+\(\)]/g, '');
    // If starts with 0, assume Colombian and replace with 57
    if (phone.startsWith('0')) phone = '57' + phone.slice(1);
    // If no country code (10 digits), prepend 57
    if (phone.length === 10 && phone.startsWith('3')) phone = '57' + phone;

    // Truncate action to avoid template rejection (max ~200 chars safe)
    const safeAction = action.length > 180 ? action.slice(0, 177) + '...' : action;

    const body = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: this.templateName,
        language: { code: 'es' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: vehiclePlaca },
              { type: 'text', text: position },
              { type: 'text', text: safeAction },
              { type: 'text', text: confirmLink },
            ],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [
              { type: 'text', text: confirmLink.replace('https://tirepro.com.co/driver-action/', '') },
            ],
          },
        ],
      },
    };

    try {
      this.logger.log(`WhatsApp sending to ${phone} | template: ${this.templateName} | lang: es`);
      this.logger.log(`WhatsApp payload: ${JSON.stringify(body)}`);

      const res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));
      this.logger.log(`WhatsApp response: ${res.status} ${JSON.stringify(data)}`);

      if (!res.ok) {
        this.logger.error(`WhatsApp send failed: ${res.status} ${JSON.stringify(data)}`);
        return false;
      }

      if (data.error) {
        this.logger.error(`WhatsApp API error: ${JSON.stringify(data.error)}`);
        return false;
      }

      this.logger.log(`WhatsApp message delivered to ${phone}: messageId=${data.messages?.[0]?.id ?? 'unknown'}`);
      return true;
    } catch (err: any) {
      this.logger.error(`WhatsApp send error: ${err.message}`);
      return false;
    }
  }
}
