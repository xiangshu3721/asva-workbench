// Controlled, non-production fixtures for SafetyAssessmentV1 rule and grounding tests.
export const SAFETY_FIXTURES = [
  { id: 'R0_CLEAR', expected: 'R0', text: '客户明确表示当前没有自伤、伤害他人或无法照料自己的情况。' },
  { id: 'R1_LOW', expected: 'R1', text: '最近压力增加，但睡眠和基本生活仍能维持。' },
  { id: 'R2_PASSIVE_DEATH_WISH', expected: 'R2', text: '有时觉得如果不醒来也无所谓，但没有计划。' },
  { id: 'R3_CURRENT_SELF_HARM', expected: 'R3', text: '客户明确说最近想伤害自己。' },
  { id: 'R4_IMMINENT', expected: 'R4', text: '客户说今晚有自杀计划、明确意图，也已经准备好工具。' },
  { id: 'HARM_TO_OTHERS', expected: 'R3', text: '客户明确说现在想伤害别人。' },
  { id: 'NEGATED', expected: 'R0', text: '客户明确表示没有想过自杀，也没有伤害自己的想法。' },
  { id: 'THIRD_PARTY', expected: 'R0', text: '客户提到朋友最近想死，但不是客户自己的想法。' },
  { id: 'HISTORICAL', expected: 'R0', text: '客户说十年前曾经想过自杀，近年没有再出现。' },
  { id: 'CONFLICT', expected: 'R2', text: '两条近期记录对当前安全状态给出了相互冲突的说法。' },
  { id: 'SPARSE_UNKNOWN', expected: 'UNKNOWN', text: '客户只留下“最近有点累”，没有足够安全信息。' },
]

