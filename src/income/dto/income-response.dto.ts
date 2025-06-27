// src/income/dto/income-response.dto.ts
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