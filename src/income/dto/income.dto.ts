// income.dto.ts
export class CreateIncomeDto {
  title: string;
  date: string; // ISO date string
  amount: number;
  note?: string;
}

export class UpdateIncomeDto {
  title?: string;
  date?: string;
  amount?: number;
  note?: string;
}

export class IncomeResponseDto {
  id: string;
  title: string;
  date: string;
  amount: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  userId: string;
}