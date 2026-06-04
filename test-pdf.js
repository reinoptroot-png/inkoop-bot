const Imap = require('imap');
const { simpleParser } = require('mailparser');
const pdfParse = require('pdf-parse');

const imap = new Imap({
  user: 'facturen@europizza.rest',
  password: 'Euro2020Pizza!!!',
  host: 'imap.one.com',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false }
});

imap.once('ready', () => {
  imap.openBox('INBOX', true, (err) => {
    const since = new Date();
    since.setDate(since.getDate() - 31);
    imap.search([['SINCE', since], ['FROM', 'lindenhoff']], (err, results) => {
      const f = imap.fetch(results, { bodies: '' });
      f.on('message', msg => {
        msg.on('body', stream => {
          simpleParser(stream, async (err, parsed) => {
            const pdf = parsed.attachments?.find(a => a.contentType.includes('pdf'));
            if (!pdf) { console.log('Geen PDF'); imap.end(); return; }
            const data = await pdfParse(pdf.content);
            console.log('PDF tekst (eerste 500 tekens):');
            console.log(data.text.substring(0, 500));
            imap.end();
          });
        });
      });
    });
  });
});
imap.once('error', e => console.log('FOUT:', e.message));
imap.connect();
