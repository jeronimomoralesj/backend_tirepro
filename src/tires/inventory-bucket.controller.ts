
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CreateBucketDto, InventoryBucketsService, MoveTireToBucketDto, UpdateBucketDto } from './inventory-bucket.service';
 
@Controller('inventory-buckets')
export class InventoryBucketsController {
  constructor(private readonly svc: InventoryBucketsService) {}
 
  // GET /inventory-buckets?companyId=xxx
  // Returns { disponible: number, buckets: InventoryBucket[] }
  @Get()
  findAll(@Query('companyId') companyId: string) {
    return this.svc.findAll(companyId);
  }
 
  // GET /inventory-buckets/disponible/tires?companyId=xxx
  // Must be declared BEFORE :id/tires so Express doesn't swallow "disponible" as an id
  @Get('disponible/tires')
  findDisponible(@Query('companyId') companyId: string) {
    return this.svc.findTiresInBucket(companyId, 'disponible');
  }
 
  // GET /inventory-buckets/:id/tires?companyId=xxx
  @Get(':id/tires')
  findTires(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    return this.svc.findTiresInBucket(companyId, id);
  }
 
  // POST /inventory-buckets
  @Post()
  create(@Body() dto: CreateBucketDto) {
    return this.svc.create(dto);
  }
 
  // PATCH /inventory-buckets/:id?companyId=xxx
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() dto: UpdateBucketDto,
  ) {
    return this.svc.update(id, companyId, dto);
  }
 
  // DELETE /inventory-buckets/:id?companyId=xxx
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    return this.svc.remove(id, companyId);
  }
 
  // POST /inventory-buckets/move
  // Body: { tireId, bucketId (string | null), companyId }
  @Post('move')
  moveTire(
    @Body() body: MoveTireToBucketDto & { companyId: string },
  ) {
    const { companyId, ...dto } = body;
    return this.svc.moveTireToBucket(dto, companyId);
  }
 
  // POST /inventory-buckets/bulk-move
  // Body: { tireIds: string[], bucketId: string | null, companyId }
  @Post('bulk-move')
  bulkMove(
    @Body() body: { tireIds: string[]; bucketId: string | null; companyId: string },
  ) {
    return this.svc.bulkMoveTiresToBucket(body.tireIds, body.bucketId, body.companyId);
  }
 
  // POST /inventory-buckets/batch-return
  // Body: {
  //   returns:         Array<{ tireId, vehicleId, posicion }>
  //   fallbackTireIds: string[]
  //   companyId:       string
  // }
  @Post('batch-return')
  batchReturn(
    @Body() body: {
      returns:         Array<{ tireId: string; vehicleId: string; posicion: number }>;
      fallbackTireIds: string[];
      companyId:       string;
    },
  ) {
    return this.svc.batchReturnToVehicles(
      body.returns,
      body.fallbackTireIds,
      body.companyId,
    );
  }
}