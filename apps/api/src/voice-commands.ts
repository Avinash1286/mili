import type { VoiceCommand } from '@tokai/contracts';

const normalize = (text: string) => text.toLowerCase().replace(/3[\s-]?d|three[\s-]d/g, '3d').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/^(hey |ok |okay )?(milli |millie |molly )?/, '').replace(/^(can you |could you |please )+/, '').replace(/( for me)?( please)?( now)?$/, '');
const commands: [RegExp, VoiceCommand][] = [
  [/^(show|open)( me)?( it)?( in| the| a| your)? 3d( model)?$/, 'show-3d'],
  [/^(close|hide)( the)? 3d( model)?$/, 'hide-3d'],
  [/^(show|open)( me)?( the| my)? (concepts?|concept map)$/, 'open-concepts'],
  [/^(show|open)( me)?( the| my)? practice$/, 'open-practice'],
  [/^(show|open)( me)?( the)? (conversation|transcript)$/, 'open-conversation'],
  [/^(finish|end)( the| this| my)? lesson$/, 'finish-lesson'],
  [/^(repeat( that| it)?|say (that|it) again|one more time)$/, 'repeat'],
];

/** Short exact phrases only, so ordinary questions always reach the tutor. */
export function matchVoiceCommand(text: string): VoiceCommand | undefined {
  if (text.length > 60) return undefined;
  const phrase = normalize(text);
  return commands.find(([pattern]) => pattern.test(phrase))?.[1];
}
