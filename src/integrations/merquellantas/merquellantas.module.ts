import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { MerquellantasController } from './merquellantas.controller';
import { MerquellantasCron } from './merquellantas.cron';
import { MerquellantasService } from './merquellantas.service';

/**
 * Integration module for Merquellantas — their Azure reporting APIs feed
 * into TirePro through the fetch-then-import pipeline orchestrated by
 * MerquellantasService. When the next distributor comes online, clone
 * this folder, swap the fetch script's URLs + field mappings, and keep
 * import-merquepro.ts as the shared landing pipeline.
 */
@Module({
  imports: [AuthModule],                  // for AdminPasswordGuard
  controllers: [MerquellantasController],
  providers: [MerquellantasService, MerquellantasCron],
  exports: [MerquellantasService],
})
export class MerquellantasModule {}
