import boardJson from '../../data/board.json';
import sectionsJson from '../../data/sections.json';
import rulesJson from '../../data/rules.json';
import rolesJson from '../../data/roles.json';
import cardsJson from '../../data/cards.json';
import type { Card, Role, Section, Square } from './types';

export const BOARD: Square[] = boardJson.squares as Square[];
export const SECTIONS: Section[] = sectionsJson.sections as Section[];
export const RULES = rulesJson;
export const ROLES: Role[] = rolesJson.roles as Role[];
export const CARDS: Card[] = cardsJson.worldEvents as Card[];

export const sectionById = new Map(SECTIONS.map((s) => [s.id, s]));
export const roleById = new Map(ROLES.map((r) => [r.id, r]));

export const PLAYER_COLORS = ['#e8590c', '#1971c2', '#2f9e44', '#ae3ec9', '#f2c94c', '#0ca678'];
