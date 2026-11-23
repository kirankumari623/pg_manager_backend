import nodemailer from "nodemailer";
import { env } from "../config/env";

// The rest of the app only knows about this tiny interface. To add another way of
// sending (Resend, SES...), write a new class with a send() method and pick it below.
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

// Prints the email in the terminal instead of sending it. Needs no setup.
class ConsoleEmailProvider implements EmailProvider {
  async send(message: EmailMessage) {
    console.log("\n=========== EMAIL (console mode, not really sent) ===========");
    console.log(`To:      ${message.to}`);
    console.log(`Subject: ${message.subject}`);
    console.log("---------------------------------------------------------");
    console.log(message.text);
    console.log("=============================================================\n");
  }
}

// Sends through any SMTP server (Gmail, Brevo, your hosting provider, ...).
class SmtpEmailProvider implements EmailProvider {
  private transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465, // 465 = encrypted from the start; 587 upgrades after connecting
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });

  async send(message: EmailMessage) {
    await this.transporter.sendMail({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

export const emailProvider: EmailProvider =
  env.EMAIL_PROVIDER === "smtp" ? new SmtpEmailProvider() : new ConsoleEmailProvider();
