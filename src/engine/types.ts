export type SquareType = 'newYear' | 'city' | 'utility' | 'event' | 'disaster' | 'airport' | 'highway' | 'tax';

export interface Square {
  index: number;
  id: string;
  type: SquareType;
  name: string;
  checkpoint: boolean;
  section?: string;
  price?: number;
  image?: string | null;
  utility?: string;
}

export interface City {
  id: string;
  name: string;
  price: number;
  landmark: string;
  image: string | null;
}

export interface Section {
  id: string;
  name: string;
  color: string;
  disasters: string[];
  cities: City[];
}

export interface Role {
  id: string;
  name: string;
  summary: string;
  startingCashDelta?: number;
  noSalary?: boolean;
  interestRate?: number;
  interestAbove?: number;
  propertyTaxMultiplier?: number;
  airportFeeMultiplier?: number;
  sectionBonusCap?: number;
  buildCostMultiplier?: number;
  utilityFeeMultiplier?: number;
  flatIncomeTax?: number;
  alwaysControlBonus?: boolean;
  costOfLivingMultiplier?: number;
}

export type CardEffect =
  | { type: 'gain'; amount: number }
  | { type: 'gainPerProperty'; amount: number }
  | { type: 'gainAndMove'; amount: number; steps: number }
  | { type: 'payAndSkip'; amount: number }
  | { type: 'skipAirportIncome' }
  | { type: 'payPercentCash'; percent: number }
  | { type: 'pay'; amount: number }
  | { type: 'payPerCityInSection'; amount: number }
  | { type: 'backToAirport' }
  | { type: 'nearestAirport'; feeMultiplier: number }
  | { type: 'advanceTo'; square: number }
  | { type: 'move'; steps: number }
  | { type: 'swapPlaces' };

export interface Card {
  id: string;
  name: string;
  kind: 'good' | 'bad' | 'neutral';
  text: string;
  effect: CardEffect;
}

export interface PlayerSetup {
  name: string;
  isBot: boolean;
  roleId: string;
}

export interface Player {
  id: number;
  name: string;
  color: string;
  isBot: boolean;
  roleId: string;
  cash: number;
  position: number;
  laps: number;
  bankrupt: boolean;
  skipNextTurn: boolean;
  skipAirportIncome: boolean;
}

export type Phase = 'roll' | 'action' | 'gameOver';

export interface LastEvent {
  title: string;
  text: string;
  kind: 'good' | 'bad' | 'neutral' | 'disaster';
}

export interface GameState {
  version: 1;
  players: Player[];
  /** square index -> player id */
  owners: Record<number, number>;
  /** city square index -> building level (0 lot, 1-4 houses, 5 hotel) */
  levels: Record<number, number>;
  current: number;
  phase: Phase;
  turn: number;
  /** 0 = no limit */
  roundLimit: number;
  dice: number[] | null;
  pendingBuy: number | null;
  canFly: boolean;
  lastEvent: LastEvent | null;
  deck: number[];
  rng: number;
  winner: number | null;
  log: string[];
}

export interface TradeOffer {
  from: number;
  to: number;
  /** squares `from` hands over */
  give: number[];
  /** squares `to` hands over */
  get: number[];
  /** cash from -> to; negative means to pays from */
  cash: number;
}
