import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailModule } from '../email/email.module';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { AiFlowBuilderService } from './ai-flow-builder.service';
import { FlowEngineService } from './flow-engine.service';
import { TriggerEvaluatorService } from './trigger-evaluator.service';
import { ActionExecutorService } from './action-executor.service';

@Module({
  imports: [EmailModule],
  controllers: [AutomationController],
  providers: [
    PrismaService,
    AutomationService,
    AiFlowBuilderService,
    FlowEngineService,
    TriggerEvaluatorService,
    ActionExecutorService,
    { provide: 'FLOW_ENGINE', useExisting: FlowEngineService },
  ],
  exports: [FlowEngineService, 'FLOW_ENGINE'],
})
export class AutomationModule {}
