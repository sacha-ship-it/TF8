'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, randomInt } = require('node:crypto');

const {
  Client,
  Events,
  GatewayIntentBits: I,
  Partials,
  ChannelType: C,
  PermissionFlagsBits: P,
  MessageFlags: F,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle: B,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle: T,
  LabelBuilder,
  FileUploadBuilder,
  AttachmentBuilder,
} = require('discord.js');

// ─────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────

const required = name => {
  if (!process.env[name]?.trim()) {
    throw Error(`Missing variable: ${name}`);
  }

  return process.env[name].trim();
};

const GUILD = required('DISCORD_GUILD_ID');
const TOKEN = required('DISCORD_TOKEN');

const SEASON = process.env.SEASON_ID || '10';

if (!/^[a-zA-Z0-9_-]{1,40}$/.test(SEASON)) {
  throw Error('Invalid SEASON_ID');
}

const START = Date.parse(
  process.env.SEASON_START ||
  '2026-11-02T00:00:00+01:00'
);

const END = Date.parse(
  process.env.SEASON_END ||
  '2026-12-01T00:00:00+01:00'
);

if (
  !Number.isFinite(START) ||
  !Number.isFinite(END) ||
  END <= START
) {
  throw Error('Invalid season dates');
}

const DIR = path.resolve(
  process.env.DATA_DIR || './data'
);

fs.mkdirSync(DIR, {
  recursive: true,
  mode: 0o700,
});

// ─────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────

const db = new DatabaseSync(
  path.join(DIR, `tf8-season-${SEASON}.sqlite`)
);

db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA busy_timeout=5000;

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    xp INTEGER NOT NULL DEFAULT 0 CHECK(xp>=0),
    message_at INTEGER NOT NULL DEFAULT 0,
    reaction_at INTEGER NOT NULL DEFAULT 0,
    loot_day TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS quests (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    format TEXT NOT NULL,
    xp INTEGER NOT NULL,
    mode TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    cursor TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS claims (
    quest TEXT NOT NULL,
    user TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL,
    review_message TEXT,
    PRIMARY KEY(quest,user)
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS invited (
    id TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS boards (
    channel TEXT PRIMARY KEY,
    message TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS boxes (
    channel TEXT PRIMARY KEY,
    message TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bytes BLOB NOT NULL
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires INTEGER NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS users_xp
  ON users(xp DESC,id);
`);

const q = (sql, ...params) =>
  db.prepare(sql).get(...params);

const rows = (sql, ...params) =>
  db.prepare(sql).all(...params);

const run = (sql, ...params) =>
  db.prepare(sql).run(...params);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');

  try {
    const result = fn();

    db.exec('COMMIT');

    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const setting = (key, fallback = null) => {
  const value = q(
    'SELECT value FROM settings WHERE key=?',
    key
  );

  return value
    ? JSON.parse(value.value)
    : fallback;
};

const set = (key, value) =>
  run(
    'INSERT INTO settings VALUES (?,?) ' +
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key,
    JSON.stringify(value)
  );

const audit = (actor, action, detail) =>
  run(
    'INSERT INTO audit(at,actor,action,detail) VALUES (?,?,?,?)',
    Date.now(),
    actor,
    action,
    JSON.stringify(detail)
  );

if (setting('guild', GUILD) !== GUILD) {
  throw Error('Database belongs to another server');
}

set('guild', GUILD);

if (
  setting('dates') &&
  JSON.stringify(setting('dates')) !==
  JSON.stringify([START, END])
) {
  throw Error(
    'Season dates differ from stored dates. ' +
    'Restore the original variables.'
  );
}

set('dates', [START, END]);

// ─────────────────────────────────────────
// XP / SEASON
// ─────────────────────────────────────────

const noPing = { parse: [] };

const day = (time = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(time));

const active = time =>
  !setting('paused', false) &&
  !setting('final', false) &&
  time >= START &&
  time < END &&
  !setting('pauses', []).some(
    ([start, end]) =>
      time >= start &&
      time < (end || Infinity)
  );

class UserError extends Error {}

const fail = message => {
  throw new UserError(message);
};

function member(id) {
  run(
    'INSERT OR IGNORE INTO users(id) VALUES (?)',
    id
  );

  return q(
    'SELECT * FROM users WHERE id=?',
    id
  );
}

function add(id, amount, actor, source) {
  const balance = member(id).xp + amount;

  if (
    !Number.isSafeInteger(balance) ||
    balance < 0
  ) {
    fail('Invalid XP balance.');
  }

  run(
    'UPDATE users SET xp=? WHERE id=?',
    balance,
    id
  );

  audit(actor, source, {
    user: id,
    amount,
  });
}

function rank(id) {
  const user = member(id);

  if (!user.xp) {
    return '**0 XP** · not ranked yet';
  }

  const above = q(
    'SELECT COUNT(*) n FROM users WHERE xp>?',
    user.xp
  ).n;

  return (
    `**${user.xp.toLocaleString('en-US')} XP**` +
    ` · rank **#${above + 1}**`
  );
}

const config = () => ({
  message: 5,
  media: 0,
  reaction: 2,
  invitation: 25,
  cooldown: 60,
  ...setting('activity', {}),
});

// ─────────────────────────────────────────
// LOOTBOX DEFAULTS
// ─────────────────────────────────────────

const defaults = [
  {
    name: 'Common',
    chance: 60,
    amount: 25,
    color: 0x95a5a6,
    description:
      'A little boost for your season. Keep showing up!',
  },
  {
    name: 'Uncommon',
    chance: 25,
    amount: 50,
    color: 0x2ecc71,
    description:
      'A solid addition to your season score.',
  },
  {
    name: 'Rare',
    chance: 10,
    amount: 100,
    color: 0x3498db,
    description:
      'A rare find. Your season just got a boost!',
  },
  {
    name: 'Epic',
    chance: 4,
    amount: 250,
    color: 0x9b59b6,
    description:
      'An epic drop. Make it count on the leaderboard!',
  },
  {
    name: 'Legendary',
    chance: 1,
    amount: 500,
    color: 0xf1c40f,
    description:
      'The biggest chest reward. What a pull!',
  },
];

const tiers = () =>
  setting('tiers', defaults);

const style = () => ({
  title: '🎁 THE FLOOR 8 DAILY CHEST',
  description:
    'Your daily chest is ready. Open it to collect XP ' +
    'for the season.\n\n' +
    'The rarer the chest, the more XP you earn.',
  color: 0x23c483,
  seconds: 3,
  image: null,
  gif: null,
  ...setting('style', {}),
});

function color(value) {
  if (
    !/^#?[0-9a-f]{6}$/i.test(value || '')
  ) {
    fail(
      'Use a HEX color, for example #23C483.'
    );
  }

  return parseInt(
    value.replace('#', ''),
    16
  );
}

const hex = number =>
  '#' + number.toString(16).padStart(6, '0');

function validTiers(list) {
  const invalid =
    list.length !== 5 ||
    list.reduce(
      (sum, tier) => sum + tier.chance,
      0
    ) !== 100 ||
    list.some((tier, index) =>
      !Number.isInteger(tier.chance) ||
      tier.chance < 0 ||
      tier.chance > 100 ||
      !Number.isInteger(tier.amount) ||
      tier.amount < 1 ||
      tier.amount > 1000000 ||
      (
        index &&
        tier.amount <= list[index - 1].amount
      )
    );

  if (invalid) {
    fail(
      'Five rarities are required. ' +
      'Chances must total 100%. ' +
      'Rewards must increase with rarity.'
    );
  }
}

function readyBox() {
  validTiers(tiers());

  const current = style();

  const assets = [
    current.image,
    current.gif,
    ...tiers().map(tier => tier.image),
  ];

  if (
    !assets.every(id =>
      id &&
      q(
        'SELECT id FROM assets WHERE id=?',
        id
      )
    )
  ) {
    fail(
      'In /lootbox, upload the welcome image, ' +
      'opening GIF and all five rarity images first.'
    );
  }
}

// ─────────────────────────────────────────
// DISCORD BUILDERS
// ─────────────────────────────────────────

const row = (...components) =>
  new ActionRowBuilder()
    .addComponents(...components);

const button = (
  id,
  label,
  buttonStyle = B.Secondary
) =>
  new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(buttonStyle);

const embed = title =>
  new EmbedBuilder()
    .setColor(0x23c483)
    .setTitle(title);

const text = (
  id,
  label,
  max,
  value = '',
  paragraph = false,
  required = true
) => {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setStyle(
      paragraph ? T.Paragraph : T.Short
    )
    .setMaxLength(max)
    .setRequired(required);

  if (value) input.setValue(value);

  return new LabelBuilder()
    .setLabel(label)
    .setTextInputComponent(input);
};

const upload = (
  id,
  label,
  required = false
) =>
  new LabelBuilder()
    .setLabel(label)
    .setFileUploadComponent(
      new FileUploadBuilder()
        .setCustomId(id)
        .setRequired(required)
        .setMinValues(required ? 1 : 0)
        .setMaxValues(1)
    );

const modal = (
  id,
  title,
  ...components
) =>
  new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(...components);

const file = (interaction, id) =>
  interaction.fields
    .getUploadedFiles(id)
    ?.first();

// ─────────────────────────────────────────
// PERSISTENT IMAGES
// ─────────────────────────────────────────

async function saveAsset(
  attachment,
  gifOnly = false
) {
  if (
    !attachment ||
    attachment.size > 8 * 1024 * 1024
  ) {
    fail('Upload a file of up to 8 MB.');
  }

  const url = new URL(attachment.url);

  if (
    url.protocol !== 'https:' ||
    ![
      'cdn.discordapp.com',
      'media.discordapp.net',
    ].includes(url.hostname)
  ) {
    fail(
      'Upload the file directly to Discord.'
    );
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });

  if (!response.ok) {
    fail(
      'File unavailable. Please upload it again.'
    );
  }

  const chunks = [];
  let size = 0;

  for await (
    const chunk of response.body
  ) {
    size += chunk.length;

    if (size > 8 * 1024 * 1024) {
      fail('Maximum file size: 8 MB.');
    }

    chunks.push(chunk);
  }

  const bytes = Buffer.concat(chunks);

  const extension =
    ['GIF87a', 'GIF89a'].includes(
      bytes.subarray(0, 6).toString()
    )
      ? 'gif'
      : bytes.subarray(0, 8).equals(
          Buffer.from([
            137, 80, 78, 71,
            13, 10, 26, 10,
          ])
        )
        ? 'png'
        : (
            bytes[0] === 255 &&
            bytes[1] === 216 &&
            bytes[2] === 255
          )
          ? 'jpg'
          : (
              bytes.subarray(0, 4)
                .toString() === 'RIFF' &&
              bytes.subarray(8, 12)
                .toString() === 'WEBP'
            )
            ? 'webp'
            : null;

  if (
    !extension ||
    (gifOnly && extension !== 'gif')
  ) {
    fail(
      gifOnly
        ? 'The opening animation must be a GIF.'
        : 'Use PNG, JPG, WEBP or GIF.'
    );
  }

  const id = randomUUID();

  run(
    'INSERT INTO assets VALUES (?,?,?)',
    id,
    `${id}.${extension}`,
    bytes
  );

  return id;
}

function visual(
  currentEmbed,
  assetId
) {
  const asset =
    assetId &&
    q(
      'SELECT * FROM assets WHERE id=?',
      assetId
    );

  if (asset) {
    currentEmbed.setImage(
      `attachment://${asset.name}`
    );
  }

  return {
    embeds: [currentEmbed],
    files: asset
      ? [
          new AttachmentBuilder(
            Buffer.from(asset.bytes),
            { name: asset.name }
          ),
        ]
      : [],
    attachments: [],
    allowedMentions: noPing,
  };
}

// ─────────────────────────────────────────
// PUBLIC LOOTBOX
// ─────────────────────────────────────────

function box() {
  const current = style();

  const currentEmbed = embed(current.title)
    .setColor(current.color)
    .setDescription(
      current.description || null
    )
    .addFields({
      name: '✨ Season XP',
      value:
        'One free chest per member per day.',
    })
    .setFooter({
      text:
        'New chest at midnight, Paris time. ' +
        'Available during the season.',
    });

  return {
    ...visual(
      currentEmbed,
      current.image
    ),
    components: [
      row(
        button(
          'box',
          '🎁 Open my chest',
          B.Primary
        )
      ),
    ],
  };
}

// ─────────────────────────────────────────
// LEADERBOARD
// ─────────────────────────────────────────

function board() {
  const list = rows(
    'SELECT * FROM users WHERE xp>0 ' +
    'ORDER BY xp DESC,id LIMIT 20'
  );

  const description = list.map(user => {
    const position = q(
      'SELECT COUNT(*) n FROM users WHERE xp>?',
      user.xp
    ).n + 1;

    return (
      `**${position}.** <@${user.id}> · ` +
      `**${user.xp.toLocaleString('en-US')} XP**`
    );
  }).join('\n');

  const currentEmbed = embed(
    `🏆 THE FLOOR 8 · SEASON ${SEASON}`
  )
    .setDescription(
      description ||
      'The season starts with you. Earn your first XP!'
    )
    .setColor(
      setting('boardcolor', 0x23c483)
    )
    .setFooter({
      text:
        'Updated every minute. ' +
        'Equal XP scores share the same rank.',
    })
    .setTimestamp();

  return {
    ...visual(
      currentEmbed,
      setting('boardimage')
    ),
    components: [
      row(
        button(
          'rank',
          'View my rank'
        )
      ),
    ],
  };
}

let refreshing = false;

async function refresh() {
  if (refreshing) return;

  refreshing = true;

  try {
    for (
      const saved of rows(
        'SELECT * FROM boards'
      )
    ) {
      try {
        const channel =
          await client.channels.fetch(
            saved.channel
          );

        const message =
          await channel.messages.fetch(
            saved.message
          );

        await message.edit(board());
      } catch (error) {
        console.error(
          'Leaderboard:',
          error.code || error.name
        );
      }
    }
  } finally {
    refreshing = false;
  }
}

async function updateBoxes() {
  for (
    const saved of rows(
      'SELECT * FROM boxes'
    )
  ) {
    try {
      const channel =
        await client.channels.fetch(
          saved.channel
        );

      const message =
        await channel.messages.fetch(
          saved.message
        );

      await message.edit(box());
    } catch (error) {
      console.error(
        'Chest message:',
        error.code || error.name
      );
    }
  }
}

// ─────────────────────────────────────────
// LOOTBOX ADMIN PANEL
// ─────────────────────────────────────────

function panel(note = '') {
  const current = style();
  const list = tiers();

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId('lb:rarity')
      .setPlaceholder(
        'Edit or preview a rarity'
      )
      .addOptions(
        ...list.map((tier, index) => ({
          label:
            `Edit ${tier.name}`.slice(0, 100),
          value: `edit:${index}`,
        })),
        ...list.map((tier, index) => ({
          label:
            `Preview ${tier.name}`.slice(0, 100),
          value: `preview:${index}`,
        }))
      );

  const description =
    `Welcome image: ${
      current.image ? '✅' : 'missing'
    }\n` +
    `Opening GIF: ${
      current.gif ? '✅' : 'missing'
    }\n\n` +
    list.map(tier =>
      `**${tier.name}** · ` +
      `${tier.chance}% · ` +
      `${tier.amount} XP · ` +
      `image ${tier.image ? '✅' : 'missing'}`
    ).join('\n') +
    '\n\nUpload one image for each rarity. ' +
    'Preview does not award XP.';

  return {
    content: note || null,
    embeds: [
      embed('🎁 Lootbox settings')
        .setDescription(description),
    ],
    components: [
      row(
        button(
          'lb:text',
          'Welcome message'
        ),
        button(
          'lb:visuals',
          'Images and GIF'
        ),
        button(
          'lb:chances',
          'Chances and rewards'
        )
      ),
      row(menu),
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId('lb:publish')
          .setPlaceholder(
            'Publish or update the daily chest'
          )
          .addChannelTypes(
            C.GuildText,
            C.GuildAnnouncement
          )
      ),
    ],
    allowedMentions: noPing,
    files: [],
    attachments: [],
  };
}

async function reveal(
  interaction,
  tier,
  preview = false
) {
  const current = style();

  try {
    if (current.gif) {
      await interaction.editReply(
        visual(
          embed('✨ Opening your lootbox…')
            .setDescription(
              'Your reward will appear in a moment!'
            ),
          current.gif
        )
      );

      await new Promise(resolve =>
        setTimeout(
          resolve,
          current.seconds * 1000
        )
      );
    }
  } catch (error) {
    console.error(
      'Animation:',
      error.code || error.name
    );
  }

  const description =
    `**+${tier.amount} XP**\n\n` +
    `${
      tier.description ||
      'A boost for your season score.'
    }\n\n` +
    (
      preview
        ? 'Preview only. No XP awarded.'
        : (
            '✅ Your XP has been added.\n' +
            rank(interaction.user.id)
          )
    );

  await interaction.editReply(
    visual(
      embed(
        `${tier.name} · ${
          preview
            ? 'PREVIEW'
            : 'CHEST REVEALED'
        }`
      )
        .setColor(tier.color)
        .setDescription(description)
        .setFooter({
          text:
            'Next chest: tomorrow at midnight, ' +
            'Paris time.',
        }),
      tier.image
    )
  );
}

// ─────────────────────────────────────────
// CLIENT / PERMISSIONS
// ─────────────────────────────────────────

const client = new Client({
  intents: [
    I.Guilds,
    I.GuildMessages,
    I.MessageContent,
    I.GuildMessageReactions,
    I.GuildMembers,
    I.GuildInvites,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
  ],
  rest: {
    timeout: 15000,
    retries: 1,
  },
});

function admin(interaction) {
  if (
    !interaction.memberPermissions
      ?.has(P.ManageGuild)
  ) {
    fail(
      'Manage Server permission required.'
    );
  }
}

function permissions(
  channel,
  requiredPermissions
) {
  if (
    !channel
      ?.permissionsFor(client.user)
      ?.has(requiredPermissions)
  ) {
    fail(
      'The bot is missing permissions ' +
      'in this channel.'
    );
  }
}

// ─────────────────────────────────────────
// COMMAND DEFINITIONS
// ─────────────────────────────────────────

const channelOption = option =>
  option
    .setName('channel')
    .setDescription('Destination channel')
    .setRequired(true)
    .addChannelTypes(
      C.GuildText,
      C.GuildAnnouncement
    );

const idOption = option =>
  option
    .setName('thread')
    .setDescription('Quest thread ID')
    .setRequired(true);

const base = (
  name,
  description,
  restricted = true
) => {
  const command =
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(description);

  return restricted
    ? command.setDefaultMemberPermissions(
        P.ManageGuild
      )
    : command;
};

const commands = [
  base(
    'quest',
    'Create and manage season quests'
  )
    .addSubcommand(sub =>
      sub
        .setName('create')
        .setDescription(
          'Create a quest in a forum'
        )
        .addChannelOption(option =>
          option
            .setName('forum')
            .setDescription('Quest forum')
            .addChannelTypes(C.GuildForum)
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option
            .setName('xp')
            .setDescription('XP reward')
            .setMinValue(1)
            .setMaxValue(1000000)
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('format')
            .setDescription(
              'Required submission format'
            )
            .setRequired(true)
            .addChoices(
              {
                name: 'Text',
                value: 'text',
              },
              {
                name: 'Image',
                value: 'image',
              },
              {
                name: 'Video',
                value: 'video',
              },
              {
                name: 'Image or video',
                value: 'media',
              }
            )
        )
        .addStringOption(option =>
          option
            .setName('validation')
            .setDescription(
              'Default: staff review'
            )
            .addChoices(
              {
                name: 'Staff review',
                value: 'manual',
              },
              {
                name: 'Automatic format check',
                value: 'auto',
              }
            )
        )
        .addStringOption(option =>
          option
            .setName('tag')
            .setDescription(
              'Exact forum tag name'
            )
            .setMaxLength(20)
        )
        .addAttachmentOption(option =>
          option
            .setName('image')
            .setDescription(
              'Optional quest image'
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('close')
        .setDescription(
          'Close and archive a quest'
        )
        .addStringOption(idOption)
    )
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('List recent quests')
    )
    .addSubcommand(sub =>
      sub
        .setName('pending')
        .setDescription(
          'Send pending submissions ' +
          'to the staff channel again'
        )
    ),

  base(
    'lootbox',
    'Configure and publish the daily lootbox'
  ),

  base(
    'leaderboard',
    'Publish or edit the season leaderboard'
  )
    .addSubcommand(sub =>
      sub
        .setName('publish')
        .setDescription(
          'Publish or update a Top 20'
        )
        .addChannelOption(channelOption)
    )
    .addSubcommand(sub =>
      sub
        .setName('appearance')
        .setDescription('Edit color or image')
        .addStringOption(option =>
          option
            .setName('color')
            .setDescription('HEX color')
            .setMaxLength(7)
        )
        .addAttachmentOption(option =>
          option
            .setName('image')
            .setDescription('Optional image')
        )
        .addBooleanOption(option =>
          option
            .setName('remove_image')
            .setDescription(
              'Remove the current image'
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('refresh')
        .setDescription(
          'Refresh leaderboards now'
        )
    ),

  base(
    'points',
    'Manage season XP'
  )
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription(
          'Add XP for an external result'
        )
        .addUserOption(option =>
          option
            .setName('member')
            .setDescription('Member')
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option
            .setName('amount')
            .setDescription('XP')
            .setMinValue(1)
            .setMaxValue(1000000)
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('reason')
            .setDescription(
              'Award reference, e.g. quiz-week1-rank1'
            )
            .setRequired(true)
            .setMaxLength(150)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription(
          'Remove XP with a reason'
        )
        .addUserOption(option =>
          option
            .setName('member')
            .setDescription('Member')
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option
            .setName('amount')
            .setDescription('XP')
            .setMinValue(1)
            .setMaxValue(1000000)
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('reason')
            .setDescription('Reason')
            .setRequired(true)
            .setMaxLength(150)
        )
    ),

  base(
    'activity',
    'Configure engagement rewards'
  )
    .addSubcommand(sub =>
      sub
        .setName('configure')
        .setDescription('Edit automatic XP')
        .addIntegerOption(option =>
          option
            .setName('message')
            .setDescription('Message XP')
            .setMinValue(0)
            .setMaxValue(1000)
        )
        .addIntegerOption(option =>
          option
            .setName('media')
            .setDescription(
              'Extra XP per image/video message'
            )
            .setMinValue(0)
            .setMaxValue(1000)
        )
        .addIntegerOption(option =>
          option
            .setName('reaction')
            .setDescription('Reaction XP')
            .setMinValue(0)
            .setMaxValue(1000)
        )
        .addIntegerOption(option =>
          option
            .setName('invitation')
            .setDescription('Invitation XP')
            .setMinValue(0)
            .setMaxValue(10000)
        )
        .addIntegerOption(option =>
          option
            .setName('cooldown')
            .setDescription(
              'Seconds between rewards'
            )
            .setMinValue(10)
            .setMaxValue(86400)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('view')
        .setDescription(
          'View automatic XP settings'
        )
    ),

  base(
    'season',
    'Season controls and exports'
  )
    .addSubcommand(sub =>
      sub
        .setName('setup')
        .setDescription(
          'Set the private review channel'
        )
        .addChannelOption(option =>
          option
            .setName('staff')
            .setDescription(
              'Private staff text channel'
            )
            .addChannelTypes(C.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('status')
        .setDescription(
          'View season dates and counters'
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('pause')
        .setDescription(
          'Pause automatic earning'
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('resume')
        .setDescription(
          'Resume automatic earning'
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('export')
        .setDescription(
          'Export the complete ranking as CSV'
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('backup')
        .setDescription(
          'Download a complete database backup'
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('finalize')
        .setDescription(
          'Freeze all XP after the season ends'
        )
    ),

  base(
    'profile',
    'View your season XP and rank',
    false
  ),
];

// ─────────────────────────────────────────
// QUEST SUBMISSIONS
// ─────────────────────────────────────────

function meets(message, format) {
  const attachments = [
    ...message.attachments.values(),
  ];

  const image = attachments.some(
    attachment =>
      attachment.contentType
        ?.startsWith('image/')
  );

  const video = attachments.some(
    attachment =>
      attachment.contentType
        ?.startsWith('video/')
  );

  return format === 'text'
    ? Boolean(message.content?.trim())
    : format === 'image'
      ? image
      : format === 'video'
        ? video
        : image || video;
}

let ready = false;
let stopping = false;
let clock;

const tasks = new Set();

function job(fn) {
  if (stopping) return;

  const promise = Promise.resolve()
    .then(fn)
    .catch(error =>
      console.error(
        'Task:',
        error.code || error.name
      )
    );

  tasks.add(promise);

  void promise.finally(() =>
    tasks.delete(promise)
  );
}

const reviewLocks = new Set();

async function reviewPost(
  quest,
  claim
) {
  const key =
    `${quest.id}:${claim.user}`;

  if (reviewLocks.has(key)) return;

  reviewLocks.add(key);

  try {
    const current = q(
      'SELECT status FROM claims ' +
      'WHERE quest=? AND user=?',
      quest.id,
      claim.user
    );

    if (
      current?.status !== 'pending'
    ) return;

    const staffId = setting('staff');

    if (!staffId) return;

    const channel =
      await client.channels.fetch(staffId);

    if (claim.review_message) {
      const oldMessage =
        await channel.messages.fetch(
          claim.review_message
        ).catch(error => {
          if (
            Number(error.code) === 10008
          ) return null;

          throw error;
        });

      if (oldMessage) return;
    }

    const link =
      `https://discord.com/channels/` +
      `${GUILD}/${quest.id}/${claim.message}`;

    const message = await channel.send({
      embeds: [
        embed('📋 Quest submission')
          .setDescription(
            `**${quest.title}**\n` +
            `Member: <@${claim.user}>\n` +
            `Reward: **${quest.xp} XP**\n\n` +
            `[Open the submission](${link})\n\n` +
            'Review the proof before approving.'
          ),
      ],
      components: [
        row(
          button(
            `review:approve:${quest.id}:${claim.user}`,
            'Approve',
            B.Success
          ),
          button(
            `review:reject:${quest.id}:${claim.user}`,
            'Reject',
            B.Danger
          )
        ),
      ],
      allowedMentions: noPing,
    });

    run(
      'UPDATE claims SET review_message=? ' +
      'WHERE quest=? AND user=?',
      message.id,
      quest.id,
      claim.user
    );
  } finally {
    reviewLocks.delete(key);
  }
}

async function processMessage(
  message,
  catchup = false
) {
  if (
    !ready ||
    message.guildId !== GUILD ||
    !message.author ||
    message.author.bot ||
    message.webhookId ||
    ![0, 19].includes(message.type)
  ) return;

  if (
    !active(message.createdTimestamp) ||
    setting('final', false)
  ) return;

  const quest = q(
    'SELECT * FROM quests ' +
    'WHERE id=? AND active=1',
    message.channelId
  );

  if (
    quest &&
    meets(message, quest.format)
  ) {
    const status =
      quest.mode === 'auto'
        ? 'approved'
        : 'pending';

    const inserted = tx(() => {
      const result = run(
        'INSERT OR IGNORE INTO claims' +
        '(quest,user,message,status) ' +
        'VALUES (?,?,?,?)',
        quest.id,
        message.author.id,
        message.id,
        status
      );

      if (
        result.changes &&
        status === 'approved'
      ) {
        add(
          message.author.id,
          quest.xp,
          'bot',
          `quest:${quest.id}`
        );
      }

      return result.changes;
    });

    if (inserted) {
      if (status === 'pending') {
        await reviewPost(quest, {
          user: message.author.id,
          message: message.id,
        });
      }

      await message.reply({
        content:
          status === 'approved'
            ? (
                '✅ Quest completed! ' +
                `**+${quest.xp} XP**.`
              )
            : (
                '📋 Submission received. ' +
                'Your XP will be added ' +
                'after staff approval.'
              ),
        allowedMentions: noPing,
      }).catch(() => {});
    }
  }

  if (
    catchup ||
    quest ||
    !active(Date.now())
  ) return;

  const current = config();

  if (
    !message.content?.trim() &&
    !message.attachments.size
  ) return;

  tx(() => {
    const inserted = run(
      'INSERT OR IGNORE INTO events VALUES (?)',
      `msg:${message.id}`
    );

    if (!inserted.changes) return;

    const user = member(
      message.author.id
    );

    if (
      message.createdTimestamp -
      user.message_at <
      current.cooldown * 1000
    ) return;

    add(
      user.id,
      current.message +
        (
          meets(message, 'media')
            ? current.media
            : 0
        ),
      'bot',
      'message'
    );

    run(
      'UPDATE users SET message_at=? WHERE id=?',
      message.createdTimestamp,
      user.id
    );
  });
}

// ─────────────────────────────────────────
// REACTIONS
// ─────────────────────────────────────────

async function reaction(
  currentReaction,
  user
) {
  if (
    !ready ||
    user.bot ||
    !active(Date.now())
  ) return;

  if (currentReaction.partial) {
    await currentReaction.fetch();
  }

  const message =
    currentReaction.message.partial
      ? await currentReaction.message.fetch()
      : currentReaction.message;

  if (
    message.guildId !== GUILD ||
    message.author?.id === user.id ||
    message.webhookId
  ) return;

  const current = config();

  if (!current.reaction) return;

  tx(() => {
    const inserted = run(
      'INSERT OR IGNORE INTO events VALUES (?)',
      `reaction:${message.id}:${user.id}`
    );

    if (!inserted.changes) return;

    const record = member(user.id);
    const now = Date.now();

    if (
      now - record.reaction_at <
      current.cooldown * 1000
    ) return;

    add(
      user.id,
      current.reaction,
      'bot',
      'reaction'
    );

    run(
      'UPDATE users SET reaction_at=? WHERE id=?',
      now,
      user.id
    );
  });
}

// ─────────────────────────────────────────
// INVITATIONS
// ─────────────────────────────────────────

let invites = null;
let inviteQueue = Promise.resolve();

async function snapshot(guild) {
  if (
    !guild.members.me?.permissions
      .has(P.ManageGuild) ||
    guild.vanityURLCode
  ) return null;

  const list =
    await guild.invites.fetch();

  return new Map(
    [...list.values()].map(invite => [
      invite.code,
      {
        uses: invite.uses || 0,
        id: invite.inviter?.id,
        bot: invite.inviter?.bot,
      },
    ])
  );
}

async function join(newMember) {
  if (
    !ready ||
    newMember.guild.id !== GUILD ||
    newMember.user.bot
  ) return;

  const previous = invites;

  invites = await snapshot(
    newMember.guild
  );

  const first = run(
    'INSERT OR IGNORE INTO invited VALUES (?)',
    newMember.id
  ).changes;

  if (
    !first ||
    !previous ||
    !invites ||
    !active(Date.now()) ||
    Date.now() -
      newMember.user.createdTimestamp <
      7 * 86400000
  ) return;

  if (
    [...previous.keys()].some(
      code => !invites.has(code)
    )
  ) return;

  const changed = [...invites].filter(
    ([code, invite]) =>
      invite.uses !==
      (previous.get(code)?.uses || 0)
  );

  if (changed.length !== 1) return;

  const [code, invite] = changed[0];

  if (
    !previous.has(code) ||
    invite.uses -
      previous.get(code).uses !== 1 ||
    !invite.id ||
    invite.bot ||
    invite.id === newMember.id
  ) return;

  tx(() =>
    add(
      invite.id,
      config().invitation,
      'bot',
      `invite:${newMember.id}`
    )
  );
}

// ─────────────────────────────────────────
// QUEST CATCH-UP AFTER RESTART
// ─────────────────────────────────────────

let catching = false;

async function catchup() {
  if (
    catching ||
    setting('paused', false) ||
    setting('final', false)
  ) return;

  catching = true;

  try {
    const quests = rows(
      'SELECT * FROM quests WHERE active=1'
    );

    for (const quest of quests) {
      try {
        const thread =
          await client.channels.fetch(
            quest.id
          );

        let before;
        let complete = false;

        const pending = [];

        for (
          let page = 0;
          page < 100;
          page++
        ) {
          const batch =
            await thread.messages.fetch({
              limit: 100,
              ...(before ? { before } : {}),
              cache: false,
            });

          const list = [
            ...batch.values(),
          ];

          pending.push(
            ...list.filter(message =>
              BigInt(message.id) >
              BigInt(quest.cursor)
            )
          );

          if (
            list.length < 100 ||
            list.some(message =>
              BigInt(message.id) <=
              BigInt(quest.cursor)
            )
          ) {
            complete = true;
            break;
          }

          before = list.reduce(
            (a, b) =>
              BigInt(a.id) < BigInt(b.id)
                ? a
                : b
          ).id;
        }

        if (!complete) {
          console.error(
            'Quest catch-up exceeds ' +
            '10,000 messages:',
            quest.id
          );

          continue;
        }

        pending.sort((a, b) =>
          BigInt(a.id) < BigInt(b.id)
            ? -1
            : 1
        );

        for (
          const message of pending
        ) {
          if (stopping) return;

          await processMessage(
            message,
            true
          );

          run(
            'UPDATE quests SET cursor=? WHERE id=?',
            message.id,
            quest.id
          );
        }
      } catch (error) {
        console.error(
          'Quest catch-up:',
          error.code || error.name
        );
      }
    }
  } finally {
    catching = false;
  }
}

// ─────────────────────────────────────────
// PUBLICATION
// ─────────────────────────────────────────

const publishLocks = new Set();

async function publish(
  interaction,
  table,
  payload,
  channel
) {
  const key =
    `${table}:${channel.id}`;

  if (publishLocks.has(key)) {
    fail(
      'Publication already in progress.'
    );
  }

  publishLocks.add(key);

  try {
    permissions(channel, [
      P.ViewChannel,
      P.SendMessages,
      P.EmbedLinks,
      P.AttachFiles,
      P.ReadMessageHistory,
    ]);

    const saved = q(
      `SELECT * FROM ${table} WHERE channel=?`,
      channel.id
    );

    let message = saved
      ? await channel.messages.fetch(
          saved.message
        ).catch(error => {
          if (
            Number(error.code) === 10008
          ) return null;

          throw error;
        })
      : null;

    if (message) {
      await message.edit(payload);
    } else {
      message =
        await channel.send(payload);
    }

    run(
      `INSERT INTO ${table} VALUES (?,?) ` +
      'ON CONFLICT(channel) DO UPDATE ' +
      'SET message=excluded.message',
      channel.id,
      message.id
    );

    await interaction.editReply(
      `✅ Published: ${message.url}`
    );
  } finally {
    publishLocks.delete(key);
  }
}

// ─────────────────────────────────────────
// INTERACTIONS
// ─────────────────────────────────────────

async function interaction(i) {
  if (i.guildId !== GUILD) return;

  if (
    !i.isChatInputCommand() &&
    !i.isButton() &&
    !i.isModalSubmit() &&
    !i.isAnySelectMenu()
  ) return;

  const supported =
    i.isChatInputCommand()
      ? commands.some(
          command =>
            command.name === i.commandName
        )
      : /^(box$|rank$|lb:|lf:|draft:|review:)/
          .test(i.customId);

  if (!supported) return;

  try {
    if (!ready || stopping) {
      fail(
        'The bot is starting. ' +
        'Please try again shortly.'
      );
    }

    const publicAction =
      i.customId === 'box' ||
      i.customId === 'rank' ||
      i.commandName === 'profile';

    if (!publicAction) admin(i);

    // LOOTBOX FORMS

    if (
      i.customId?.startsWith('lb:')
    ) {
      const action =
        i.customId.split(':')[1];

      const current = style();

      if (action === 'text') {
        return await i.showModal(
          modal(
            'lf:text',
            'Welcome message',
            text(
              'title',
              'Title',
              100,
              current.title
            ),
            text(
              'description',
              'Text with Markdown',
              2000,
              current.description,
              true,
              false
            ),
            text(
              'color',
              'HEX color',
              7,
              hex(current.color)
            )
          )
        );
      }

      if (action === 'visuals') {
        return await i.showModal(
          modal(
            'lf:visuals',
            'Chest images and animation',
            upload(
              'image',
              'Welcome image',
              !current.image
            ),
            upload(
              'gif',
              'Opening GIF',
              !current.gif
            ),
            text(
              'seconds',
              'GIF duration: 1 to 15 seconds',
              2,
              String(current.seconds)
            )
          )
        );
      }

      if (action === 'chances') {
        return await i.showModal(
          modal(
            'lf:chances',
            'Chance % ; XP reward',
            ...tiers().map(
              (tier, index) =>
                text(
                  `t${index}`,
                  tier.name.slice(0, 45),
                  20,
                  `${tier.chance};${tier.amount}`
                )
            )
          )
        );
      }

      if (action === 'rarity') {
        const [choice, index] =
          i.values[0].split(':');

        const tier =
          tiers()[Number(index)];

        if (!tier) {
          fail('Unknown rarity.');
        }

        if (choice === 'edit') {
          return await i.showModal(
            modal(
              `lf:rarity:${index}`,
              'Customize this rarity',
              text(
                'name',
                'Name',
                80,
                tier.name
              ),
              text(
                'description',
                'Reward text',
                2000,
                tier.description || '',
                true,
                false
              ),
              text(
                'gain',
                'Chance % ; XP reward',
                20,
                `${tier.chance};${tier.amount}`
              ),
              text(
                'color',
                'HEX color',
                7,
                hex(tier.color)
              ),
              upload(
                'image',
                'Dedicated rarity image',
                !tier.image
              )
            )
          );
        }

        await i.deferReply({
          flags: F.Ephemeral,
        });

        return await reveal(
          i,
          tier,
          true
        );
      }
    }

    // QUEST CREATION FORM

    if (
      i.isChatInputCommand() &&
      i.commandName === 'quest' &&
      i.options.getSubcommand() === 'create'
    ) {
      if (!active(Date.now())) {
        fail(
          'The season is not open for new quests.'
        );
      }

      const draft = {
        forum:
          i.options.getChannel('forum').id,
        xp:
          i.options.getInteger('xp'),
        format:
          i.options.getString('format'),
        mode:
          i.options.getString('validation') ||
          'manual',
        tag:
          i.options.getString('tag'),
        image:
          i.options.getAttachment('image'),
      };

      if (
        draft.mode === 'manual' &&
        !setting('staff')
      ) {
        fail(
          'Run /season setup first.'
        );
      }

      if (draft.image) {
        draft.image = {
          url: draft.image.url,
          size: draft.image.size,
        };
      }

      const id = randomUUID();

      run(
        'INSERT INTO drafts VALUES (?,?,?,?)',
        id,
        i.user.id,
        Date.now() + 20 * 60000,
        JSON.stringify(draft)
      );

      return await i.showModal(
        modal(
          `draft:${id}`,
          'Create a quest',
          text(
            'title',
            'Quest title',
            100
          ),
          text(
            'body',
            'Quest instructions',
            3500,
            '',
            true
          )
        )
      );
    }

    await i.deferReply({
      flags: F.Ephemeral,
    });

    // PUBLIC RANK

    if (
      i.customId === 'rank' ||
      i.commandName === 'profile'
    ) {
      return await i.editReply(
        rank(i.user.id)
      );
    }

    // OPEN DAILY CHEST

    if (i.customId === 'box') {
      const registered = q(
        'SELECT channel FROM boxes WHERE message=?',
        i.message.id
      );

      if (!registered) {
        fail(
          'This chest is no longer registered.'
        );
      }

      if (!active(Date.now())) {
        fail(
          'The season is paused, ' +
          'not started or has ended.'
        );
      }

      readyBox();

      const tier = tx(() => {
        const user = member(i.user.id);
        const today = day();

        if (
          user.loot_day === today
        ) {
          fail(
            'You already opened your chest today. ' +
            'Come back after midnight, Paris time!'
          );
        }

        let roll = randomInt(100);
        let selected;

        for (
          const candidate of tiers()
        ) {
          if (
            roll < candidate.chance
          ) {
            selected = candidate;
            break;
          }

          roll -= candidate.chance;
        }

        add(
          user.id,
          selected.amount,
          user.id,
          `lootbox:${selected.name}`
        );

        run(
          'UPDATE users SET loot_day=? WHERE id=?',
          today,
          user.id
        );

        return selected;
      });

      return await reveal(i, tier);
    }

    // PUBLISH CHEST

    if (
      i.customId?.startsWith(
        'lb:publish'
      )
    ) {
      readyBox();

      const channel =
        await i.guild.channels.fetch(
          i.values[0]
        );

      return await publish(
        i,
        'boxes',
        box(),
        channel
      );
    }

    // SAVE LOOTBOX SETTINGS

    if (
      i.customId?.startsWith('lf:')
    ) {
      const [, action, index] =
        i.customId.split(':');

      const current = style();

      if (action === 'text') {
        current.title =
          i.fields
            .getTextInputValue('title')
            .trim();

        if (!current.title) {
          fail('Title required.');
        }

        current.description =
          i.fields.getTextInputValue(
            'description'
          );

        current.color = color(
          i.fields.getTextInputValue(
            'color'
          )
        );

        set('style', current);
      } else if (
        action === 'visuals'
      ) {
        current.seconds = Number(
          i.fields.getTextInputValue(
            'seconds'
          )
        );

        if (
          !Number.isInteger(
            current.seconds
          ) ||
          current.seconds < 1 ||
          current.seconds > 15
        ) {
          fail(
            'Duration: 1 to 15 seconds.'
          );
        }

        if (file(i, 'image')) {
          current.image =
            await saveAsset(
              file(i, 'image')
            );
        }

        if (file(i, 'gif')) {
          current.gif =
            await saveAsset(
              file(i, 'gif'),
              true
            );
        }

        set('style', current);
      } else if (
        action === 'rarity' ||
        action === 'chances'
      ) {
        const list = tiers();

        const parse = value => {
          const match = value.trim().match(
            /^(\d{1,3})\s*;\s*(\d{1,7})$/
          );

          if (!match) {
            fail(
              'Use chance;reward, ' +
              'for example 60;25.'
            );
          }

          return {
            chance: Number(match[1]),
            amount: Number(match[2]),
          };
        };

        if (
          action === 'rarity'
        ) {
          const tier =
            list[Number(index)];

          if (!tier) {
            fail(
              'Unknown rarity.'
            );
          }

          Object.assign(
            tier,
            parse(
              i.fields.getTextInputValue(
                'gain'
              )
            ),
            {
              name:
                i.fields
                  .getTextInputValue('name')
                  .trim(),
              description:
                i.fields.getTextInputValue(
                  'description'
                ),
              color: color(
                i.fields.getTextInputValue(
                  'color'
                )
              ),
            }
          );

          if (!tier.name) {
            fail('Name required.');
          }

          if (
            tier.chance > 100 ||
            tier.amount < 1 ||
            tier.amount > 1000000
          ) {
            fail(
              'Chance: 0 to 100. ' +
              'Reward: 1 to 1,000,000 XP.'
            );
          }

          if (file(i, 'image')) {
            tier.image =
              await saveAsset(
                file(i, 'image')
              );
          }
        } else {
          list.forEach(
            (tier, number) =>
              Object.assign(
                tier,
                parse(
                  i.fields.getTextInputValue(
                    `t${number}`
                  )
                )
              )
          );
        }

        if (
          action === 'chances'
        ) {
          validTiers(list);
        }

        set('tiers', list);
      }

      await updateBoxes();

      return await i.editReply(
        panel('✅ Settings saved.')
      );
    }

    // PUBLISH QUEST

    if (
      i.customId?.startsWith('draft:')
    ) {
      const id =
        i.customId.slice(6);

      const record = q(
        'SELECT * FROM drafts WHERE id=?',
        id
      );

      if (
        !record ||
        record.owner !== i.user.id ||
        record.expires < Date.now()
      ) {
        fail(
          'Form expired. ' +
          'Run /quest create again.'
        );
      }

      if (!active(Date.now())) {
        fail(
          'The season is not open.'
        );
      }

      const draft =
        JSON.parse(record.data);

      const forum =
        await i.guild.channels.fetch(
          draft.forum
        );

      permissions(forum, [
        P.ViewChannel,
        P.SendMessages,
        P.SendMessagesInThreads,
        P.EmbedLinks,
        P.AttachFiles,
        P.ReadMessageHistory,
      ]);

      const title =
        i.fields
          .getTextInputValue('title')
          .trim();

      const body =
        i.fields
          .getTextInputValue('body')
          .trim();

      if (!title || !body) {
        fail(
          'Title and text are required.'
        );
      }

      const tags = [];

      if (draft.tag) {
        const tag =
          forum.availableTags.find(
            tag =>
              tag.name === draft.tag
          );

        if (!tag) {
          fail(
            'Forum tag not found.'
          );
        }

        tags.push(tag.id);
      }

      if (
        forum.flags.has('RequireTag') &&
        !tags.length
      ) {
        fail(
          'This forum requires a tag. ' +
          'Use the tag option.'
        );
      }

      if (
        !run(
          'DELETE FROM drafts WHERE id=?',
          id
        ).changes
      ) {
        fail(
          'Form already submitted.'
        );
      }

      const imageId = draft.image
        ? await saveAsset(draft.image)
        : null;

      const payload = visual(
        embed(title)
          .setDescription(body)
          .addFields(
            {
              name: 'Reward',
              value:
                `**${draft.xp} XP**`,
            },
            {
              name:
                'How to participate',
              value:
                `Reply in this post with ` +
                `**${draft.format}**. ` +
                'One reward per member. ' +
                (
                  draft.mode === 'manual'
                    ? 'Staff approval required.'
                    : (
                        'Automatic format check only; ' +
                        'no content verification.'
                      )
                ),
            }
          ),
        imageId
      );

      const thread =
        await forum.threads.create({
          name: title,
          appliedTags: tags,
          message: payload,
        });

      run(
        'INSERT INTO quests' +
        '(id,title,format,xp,mode,cursor) ' +
        'VALUES (?,?,?,?,?,?)',
        thread.id,
        title,
        draft.format,
        draft.xp,
        draft.mode,
        thread.id
      );

      audit(
        i.user.id,
        'quest-created',
        {
          id: thread.id,
          ...draft,
        }
      );

      return await i.editReply(
        `✅ Quest created: <#${thread.id}>` +
        ` · **${draft.xp} XP**.`
      );
    }

    // STAFF APPROVAL

    if (
      i.customId?.startsWith(
        'review:'
      )
    ) {
      const [
        ,
        action,
        questId,
        userId,
      ] = i.customId.split(':');

      if (
        ![
          'approve',
          'reject',
        ].includes(action)
      ) {
        fail('Unknown action.');
      }

      if (
        setting('final', false)
      ) {
        fail(
          'The season is finalized.'
        );
      }

      tx(() => {
        const claim = q(
          'SELECT * FROM claims ' +
          'WHERE quest=? AND user=?',
          questId,
          userId
        );

        if (
          !claim ||
          claim.status !== 'pending'
        ) {
          fail(
            'Submission already reviewed.'
          );
        }

        const quest = q(
          'SELECT * FROM quests WHERE id=?',
          questId
        );

        run(
          'UPDATE claims SET status=? ' +
          'WHERE quest=? AND user=?',
          action === 'approve'
            ? 'approved'
            : 'rejected',
          questId,
          userId
        );

        if (
          action === 'approve'
        ) {
          add(
            userId,
            quest.xp,
            i.user.id,
            `quest:${questId}`
          );
        }

        audit(
          i.user.id,
          action,
          {
            quest: questId,
            user: userId,
          }
        );
      });

      await i.message.edit({
        components: [],
      }).catch(() => {});

      await client.users.send(
        userId,
        {
          content:
            action === 'approve'
              ? (
                  '✅ Quest approved! ' +
                  rank(userId)
                )
              : (
                  'Your quest submission ' +
                  'was not approved. ' +
                  'Contact the staff if ' +
                  'you have a question.'
                ),
        }
      ).catch(() => {});

      return await i.editReply(
        action === 'approve'
          ? '✅ XP awarded.'
          : (
              'Submission rejected. ' +
              'No XP awarded.'
            )
      );
    }

    const command =
      i.commandName;

    const subcommand =
      i.options?.getSubcommand(
        false
      );

    // LOOTBOX PANEL

    if (
      command === 'lootbox'
    ) {
      return await i.editReply(
        panel()
      );
    }

    // QUEST MANAGEMENT

    if (
      command === 'quest'
    ) {
      if (
        subcommand === 'list'
      ) {
        const list = rows(
          'SELECT * FROM quests ' +
          'ORDER BY rowid DESC LIMIT 20'
        );

        return await i.editReply({
          content:
            list.map(quest =>
              `<#${quest.id}> · ` +
              `${quest.xp} XP · ` +
              `${quest.mode} · ` +
              `${
                quest.active
                  ? 'open'
                  : 'closed'
              }`
            ).join('\n') ||
            'No quests yet.',
          allowedMentions: noPing,
        });
      }

      if (
        subcommand === 'pending'
      ) {
        const pending = rows(
          "SELECT * FROM claims " +
          "WHERE status='pending' " +
          'LIMIT 20'
        );

        for (
          const claim of pending
        ) {
          await reviewPost(
            q(
              'SELECT * FROM quests WHERE id=?',
              claim.quest
            ),
            claim
          );
        }

        return await i.editReply(
          `${pending.length} pending ` +
          'submissions checked. ' +
          'Existing review messages are kept.'
        );
      }

      const id =
        i.options.getString(
          'thread'
        );

      if (
        !q(
          'SELECT id FROM quests WHERE id=?',
          id
        )
      ) {
        fail(
          'Quest not found. ' +
          'Use its thread ID.'
        );
      }

      run(
        'UPDATE quests SET active=0 WHERE id=?',
        id
      );

      const thread =
        await i.guild.channels.fetch(
          id
        );

      await thread.setLocked(
        true
      );

      await thread.setArchived(
        true
      );

      return await i.editReply(
        'Quest closed. ' +
        'Pending submissions can still be reviewed.'
      );
    }

    // LEADERBOARD MANAGEMENT

    if (
      command === 'leaderboard'
    ) {
      if (
        subcommand === 'publish'
      ) {
        return await publish(
          i,
          'boards',
          board(),
          i.options.getChannel(
            'channel'
          )
        );
      }

      if (
        subcommand === 'appearance'
      ) {
        const selectedColor =
          i.options.getString(
            'color'
          );

        if (selectedColor) {
          set(
            'boardcolor',
            color(selectedColor)
          );
        }

        if (
          i.options.getBoolean(
            'remove_image'
          )
        ) {
          set(
            'boardimage',
            null
          );
        }

        const attachment =
          i.options.getAttachment(
            'image'
          );

        if (attachment) {
          set(
            'boardimage',
            await saveAsset(
              attachment
            )
          );
        }
      }

      await refresh();

      return await i.editReply(
        '✅ Leaderboards refreshed.'
      );
    }

    // MANUAL XP

    if (
      command === 'points'
    ) {
      if (
        setting('final', false)
      ) {
        fail(
          'The season is finalized.'
        );
      }

      const user =
        i.options.getUser(
          'member'
        );

      if (user.bot) {
        fail(
          'Bots cannot earn XP.'
        );
      }

      const amount =
        i.options.getInteger(
          'amount'
        ) *
        (
          subcommand === 'add'
            ? 1
            : -1
        );

      const reason =
        i.options
          .getString('reason')
          .trim();

      if (!reason) {
        fail(
          'Reason required.'
        );
      }

      tx(() => {
        const key =
          `award:${subcommand}:` +
          `${user.id}:${reason}`;

        const inserted = run(
          'INSERT OR IGNORE INTO events VALUES (?)',
          key
        );

        if (
          !inserted.changes
        ) {
          fail(
            'This reference has already ' +
            'been used for this member.'
          );
        }

        add(
          user.id,
          amount,
          i.user.id,
          reason
        );
      });

      return await i.editReply(
        `✅ ${rank(user.id)}`
      );
    }

    // ENGAGEMENT SETTINGS

    if (
      command === 'activity'
    ) {
      const current = config();

      if (
        subcommand === 'configure'
      ) {
        for (
          const key of Object.keys(
            current
          )
        ) {
          const number =
            i.options.getInteger(
              key
            );

          if (
            number !== null
          ) {
            current[key] =
              number;
          }
        }
      }

      set(
        'activity',
        current
      );

      return await i.editReply(
        `Message: ${current.message} XP\n` +
        `Media bonus: ${current.media} XP\n` +
        `Reaction: ${current.reaction} XP\n` +
        `Invitation: ${current.invitation} XP\n` +
        `Cooldown: ${current.cooldown}s\n` +
        'Rewards apply to accessible server channels. ' +
        'Quest submissions have no message XP bonus.'
      );
    }

    // SEASON MANAGEMENT

    if (
      command === 'season'
    ) {
      if (
        subcommand === 'setup'
      ) {
        const channel =
          i.options.getChannel(
            'staff'
          );

        if (
          channel.permissionsFor(
            i.guild.roles.everyone
          )?.has(
            P.ViewChannel
          )
        ) {
          fail(
            'Choose a private staff channel.'
          );
        }

        permissions(
          channel,
          [
            P.ViewChannel,
            P.SendMessages,
            P.EmbedLinks,
            P.ReadMessageHistory,
          ]
        );

        set(
          'staff',
          channel.id
        );

        return await i.editReply(
          '✅ Review channel saved.'
        );
      }

      if (
        subcommand === 'pause' ||
        subcommand === 'resume'
      ) {
        if (
          setting('final', false)
        ) {
          fail(
            'The season is finalized.'
          );
        }

        const pauses =
          setting(
            'pauses',
            []
          );

        if (
          subcommand === 'pause' &&
          !setting(
            'paused',
            false
          )
        ) {
          pauses.push([
            Date.now(),
            null,
          ]);
        }

        if (
          subcommand === 'resume' &&
          setting(
            'paused',
            false
          ) &&
          pauses.length &&
          pauses.at(-1)[1] === null
        ) {
          pauses.at(-1)[1] =
            Date.now();
        }

        set(
          'pauses',
          pauses
        );

        set(
          'paused',
          subcommand === 'pause'
        );

        audit(
          i.user.id,
          subcommand,
          {}
        );

        return await i.editReply(
          subcommand === 'pause'
            ? 'Automatic earning paused.'
            : (
                'Automatic earning resumed ' +
                'within the season dates.'
              )
        );
      }

      if (
        subcommand === 'export'
      ) {
        const list = rows(
          'SELECT id,xp FROM users ' +
          'WHERE xp>0 ' +
          'ORDER BY xp DESC,id'
        );

        let last;
        let position = 0;

        const csv =
          'rank;discord_id;xp\r\n' +
          list.map(
            (user, index) => {
              if (
                user.xp !== last
              ) {
                position =
                  index + 1;
              }

              last = user.xp;

              return (
                `${position};` +
                `="${user.id}";` +
                `${user.xp}`
              );
            }
          ).join('\r\n');

        return await i.editReply({
          files: [
            new AttachmentBuilder(
              Buffer.from(
                '\uFEFF' + csv
              ),
              {
                name:
                  `tf8-season-${SEASON}.csv`,
              }
            ),
          ],
        });
      }

      if (
        subcommand === 'backup'
      ) {
        const target =
          path.join(
            DIR,
            `backup-${randomUUID()}.sqlite`
          );

        db.prepare(
          'VACUUM INTO ?'
        ).run(target);

        try {
          await i.editReply({
            files: [
              new AttachmentBuilder(
                target,
                {
                  name:
                    `tf8-season-${SEASON}-backup.sqlite`,
                }
              ),
            ],
          });
        } finally {
          fs.unlinkSync(
            target
          );
        }

        return;
      }

      if (
        subcommand === 'finalize'
      ) {
        if (
          Date.now() < END
        ) {
          fail(
            'Wait until the season ends ' +
            'before finalizing.'
          );
        }

        const pending = q(
          "SELECT COUNT(*) n FROM claims " +
          "WHERE status='pending'"
        ).n;

        if (pending) {
          fail(
            'Review all pending ' +
            'submissions first.'
          );
        }

        set(
          'final',
          true
        );

        set(
          'paused',
          true
        );

        audit(
          i.user.id,
          'finalized',
          {}
        );

        await refresh();

        return await i.editReply(
          'Season finalized. ' +
          'All XP is now frozen. ' +
          'Export the final ranking.'
        );
      }

      const participants = q(
        'SELECT COUNT(*) n FROM users WHERE xp>0'
      ).n;

      const pending = q(
        "SELECT COUNT(*) n FROM claims " +
        "WHERE status='pending'"
      ).n;

      return await i.editReply(
        `Season ${SEASON}\n` +
        `Starts: <t:${Math.floor(START / 1000)}:F>\n` +
        `Ends: <t:${Math.floor(END / 1000)}:F> (exclusive)\n` +
        `Automatic earning: ${
          active(Date.now())
            ? 'open'
            : 'closed'
        }\n` +
        `Finalized: ${
          setting('final', false)
        }\n` +
        `Participants with XP: ${participants}\n` +
        `Pending proofs: ${pending}`
      );
    }
  } catch (error) {
    console.error(
      'Interaction:',
      error.code || error.name
    );

    const content =
      error instanceof UserError
        ? error.message
        : (
            'Operation not confirmed. ' +
            'Check the logs and your XP before retrying; ' +
            'recorded rewards are kept.'
          );

    if (
      i.deferred ||
      i.replied
    ) {
      await i.editReply({
        content,
        embeds: [],
        components: [],
        attachments: [],
      }).catch(() => {});
    } else {
      await i.reply({
        content,
        flags: F.Ephemeral,
      }).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────

client.on(
  Events.InteractionCreate,
  i => job(
    () => interaction(i)
  )
);

client.on(
  Events.MessageCreate,
  message => job(
    () => processMessage(message)
  )
);

client.on(
  Events.MessageUpdate,
  (_old, message) => job(
    async () =>
      processMessage(
        message.partial
          ? await message.fetch()
          : message,
        true
      )
  )
);

client.on(
  Events.MessageReactionAdd,
  (currentReaction, user) => job(
    () => reaction(
      currentReaction,
      user
    )
  )
);

client.on(
  Events.GuildMemberAdd,
  newMember => {
    inviteQueue =
      inviteQueue
        .then(
          () => join(newMember)
        )
        .catch(error => {
          invites = null;

          console.error(
            'Invitations:',
            error.code || error.name
          );
        });
  }
);

client.on(
  Events.InviteCreate,
  invite => {
    if (
      invite.guild.id === GUILD &&
      invites
    ) {
      invites.set(
        invite.code,
        {
          uses: invite.uses || 0,
          id:
            invite.inviter?.id,
          bot:
            invite.inviter?.bot,
        }
      );
    }
  }
);

client.on(
  Events.ShardResume,
  () => job(catchup)
);

client.on(
  Events.Error,
  error =>
    console.error(
      'Discord:',
      error.code || error.name
    )
);

// ─────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────

client.once(
  Events.ClientReady,
  () => job(async () => {
    const guild =
      await client.guilds.fetch(
        GUILD
      );

    // Use a dedicated Discord application.
    // Replaces this application's guild commands.
    await guild.commands.set(
      commands.map(
        command =>
          command.toJSON()
      )
    );

    invites =
      await snapshot(guild)
        .catch(() => null);

    if (!invites) {
      console.warn(
        'Invite attribution unavailable: ' +
        'check Manage Server permission ' +
        'and vanity URL.'
      );
    }

    ready = true;

    console.log(
      `TF8 season ${SEASON} ready.`
    );

    await refresh();
    await catchup();

    clock = setInterval(
      () => {
        job(refresh);
        job(catchup);

        run(
          'DELETE FROM drafts WHERE expires<?',
          Date.now()
        );
      },
      60000
    );
  })
);

// ─────────────────────────────────────────
// SHUTDOWN
// ─────────────────────────────────────────

async function shutdown() {
  if (stopping) return;

  stopping = true;
  ready = false;

  clearInterval(clock);

  const timer = setTimeout(
    () => process.exit(1),
    25000
  );

  await Promise.allSettled([
    ...tasks,
    inviteQueue,
  ]);

  client.destroy();
  db.close();

  clearTimeout(timer);

  process.exit(0);
}

process.once(
  'SIGTERM',
  () => void shutdown()
);

process.once(
  'SIGINT',
  () => void shutdown()
);

if (
  require.main === module
) {
  client.login(TOKEN)
    .catch(error => {
      console.error(
        'Login failed:',
        error.code || error.name
      );

      process.exitCode = 1;

      client.destroy();
      db.close();
    });
}
