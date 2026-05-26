'use strict';

const express      = require('express');
const { spawn }    = require('child_process');
const path         = require('path');
const { Kafka }    = require('kafkajs');

const app    = express();
const PORT   = process.env.PORT || 3000;
const RUN_SH = path.resolve(__dirname, '..', 'run.sh');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Parse the --list-fields output into a structured array:
//   "  accountId    5eb04bc6af93511527471000  (String)"
//   → { name, value, type }
// ---------------------------------------------------------------------------
function parseFields(output) {
    const fields = [];
    for (const line of output.split('\n')) {
        const m = line.match(/^\s{2}(\S+)\s+(.*?)\s+\((\w+)\)\s*$/);
        if (m) fields.push({ name: m[1], value: m[2].trim(), type: m[3] });
    }
    return fields;
}

// ---------------------------------------------------------------------------
// GET /api/fields  — returns default payload fields from --list-fields
// ---------------------------------------------------------------------------
app.get('/api/fields', (req, res) => {
    const args = ['--list-fields'];
    const proc = spawn('bash', [RUN_SH, ...args]);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    proc.on('close', () => res.json(parseFields(out)));
});

// ---------------------------------------------------------------------------
// POST /api/send  — SSE stream; runs run.sh and streams its output line by line
//
// Body: {
//   bootstrap, topic, accountId, assetId, count,
//   dockerNetwork, compress, dryRun,
//   fields: { key: value, … }   ← user-edited values
// }
// ---------------------------------------------------------------------------
app.post('/api/send', (req, res) => {
    const {
        bootstrap    = 'kafkaQA:9092',
        topic,
        accountId,
        assetId,
        count        = 1,
        dockerNetwork,
        compress     = false,
        dryRun       = false,
        fields       = {}
    } = req.body;

    const args = ['--bootstrap', bootstrap];
    if (topic)         args.push('--topic',      topic);
    if (accountId)     args.push('--account-id', accountId);
    if (assetId)       args.push('--asset-id',   assetId);
    if (count > 1)     args.push('--count',      String(count));
    if (compress)      args.push('--compress');
    if (dryRun)        args.push('--dry-run');
    if (dockerNetwork) args.push('--docker-network', dockerNetwork);

    for (const [key, value] of Object.entries(fields)) {
        args.push('--field', `${key}=${value}`);
    }

    // Server-Sent Events
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');

    const send = (type, text) =>
        res.write(`data: ${JSON.stringify({ type, text })}\n\n`);

    send('args', 'bash run.sh ' + args.join(' '));

    const proc = spawn('bash', [RUN_SH, ...args]);
    proc.stdout.on('data', d => send('out', d.toString()));
    proc.stderr.on('data', d => send('err', d.toString()));
    proc.on('close', code => { send('done', String(code)); res.end(); });
});

// ---------------------------------------------------------------------------
// GET /api/consume  — SSE stream; connects a kafkajs consumer and streams
//                     each received message as a JSON event.
//
// Query params:
//   bootstrap     Kafka bootstrap server  (default: kafkaQA:9092)
//   topic         Topic to subscribe to   (required)
//   fromBeginning "true" to start from offset 0; default false (latest)
//   groupId       Consumer group id       (default: ui-consumer-<timestamp>)
// ---------------------------------------------------------------------------
app.get('/api/consume', async (req, res) => {
    const {
        bootstrap     = 'kafkaQA:9092',
        topic,
        fromBeginning = 'false',
        groupId,
    } = req.query;

    if (!topic) return res.status(400).json({ error: 'topic is required' });

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');

    const send = (type, payload) =>
        res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);

    const gid = groupId || `ui-consumer-${Date.now()}`;

    const kafka = new Kafka({
        clientId: 'kafka-ui-consumer',
        brokers:  [bootstrap],
        // suppress KafkaJS startup noise in the server console
        logLevel: 1, // ERROR only
    });

    const consumer = kafka.consumer({ groupId: gid });
    let stopped = false;

    // Clean up when the browser closes the SSE connection
    req.on('close', async () => {
        if (stopped) return;
        stopped = true;
        try { await consumer.disconnect(); } catch (_) {}
    });

    try {
        send('status', { text: `Connecting to ${bootstrap} …` });
        await consumer.connect();

        send('status', { text: `Subscribing to "${topic}" (fromBeginning=${fromBeginning}) …` });
        await consumer.subscribe({ topic, fromBeginning: fromBeginning === 'true' });

        send('status', { text: `Subscribed. Waiting for messages…` });

        // eachMessage runs in the consumer's own async loop
        await consumer.run({
            eachMessage: async ({ topic: t, partition, message }) => {
                if (stopped) return;
                const valueHex = message.value  ? message.value.toString('hex')  : null;
                const keyHex   = message.key    ? message.key.toString('hex')    : null;
                send('message', {
                    topic:     t,
                    partition,
                    offset:    message.offset,
                    timestamp: message.timestamp,
                    keyHex,
                    valueHex,
                    valueSize: message.value ? message.value.length : 0,
                });
            },
        });
    } catch (err) {
        if (!stopped) send('error', { text: err.message });
        res.end();
    }
});

app.listen(PORT, () =>
    console.log(`kafka-securityevent-producer UI → http://localhost:${PORT}`));
