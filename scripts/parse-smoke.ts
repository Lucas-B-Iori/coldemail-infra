import { simpleParser } from 'mailparser';
import { parseBounce, isUnsubscribe, replyText } from '../src/inbox/parse.ts';

const dsn = `From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: conta1@gmail.com
Subject: Delivery Status Notification (Failure)
Content-Type: multipart/report; report-type=delivery-status; boundary="b"
MIME-Version: 1.0

--b
Content-Type: text/plain

Address not found. Your message wasn't delivered to carlos@teste1.com.br because the address couldn't be found.

--b
Content-Type: message/delivery-status

Final-Recipient: rfc822; carlos@teste1.com.br
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 User unknown

--b--
`;
const m = await simpleParser(dsn);
console.log('bounce:', parseBounce(m, new Set(['conta1@gmail.com'])));

const reply = await simpleParser(`From: Carlos <carlos@teste1.com.br>
To: conta1@gmail.com
Subject: Re: pergunta
In-Reply-To: <x@y>

Pode me mostrar sim, terça às 15h?

Em ter, 6 de out, Marcos escreveu:
> Olá`);
console.log('reply:', JSON.stringify(replyText(reply)), 'unsub:', isUnsubscribe(replyText(reply)));
console.log('unsub:', isUnsubscribe('Por favor remova meu e-mail da lista'));
