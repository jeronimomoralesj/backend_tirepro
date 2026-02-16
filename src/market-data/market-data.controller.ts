import { Controller, Get, Post, Put, Query, Body, Param, HttpException, HttpStatus } from '@nestjs/common';
import { MarketDataService } from './market-data.service';

@Controller('market-data')
export class MarketDataController {
  constructor(private readonly marketDataService: MarketDataService) {}

  /**
   * STARTER ENDPOINT - Run once to populate the database
   * DELETE THIS AFTER FIRST RUN
   * 
   * Usage: POST http://localhost:3000/market-data/initial-scrape
   */
  @Post('initial-scrape')
  async runInitialScrape() {
    try {
      const result = await this.marketDataService.initialScrapeAndPopulate();
      return {
        success: result.success,
        message: `Initial scrape completed. Created ${result.tiresCreated} tire entries.`,
        tiresCreated: result.tiresCreated,
        errors: result.errors,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Initial scrape failed',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Query tire data by brand and design
   * GET /market-data/tire?marca=Continental&diseno=HDR2&dimension=295/80R22.5
   */
  @Get('tire')
  async getTireData(
    @Query('marca') marca: string,
    @Query('diseno') diseno: string,
    @Query('dimension') dimension?: string,
  ) {
    try {
      if (!marca || !diseno) {
        throw new HttpException(
          'marca and diseno are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const tires = await this.marketDataService.getTireData(marca, diseno, dimension);
      
      if (tires.length === 0) {
        return {
          success: false,
          message: 'No tire data found for the specified criteria',
          data: null,
        };
      }

      return {
        success: true,
        data: tires,
        count: tires.length,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to retrieve tire data',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get specific tire by exact reference
   * GET /market-data/tire/Continental/HDR2/295-80R22.5
   */
  @Get('tire/:brand/:diseno/:dimension')
  async getTireByReference(
    @Param('brand') brand: string,
    @Param('diseno') diseno: string,
    @Param('dimension') dimension: string,
  ) {
    try {
      // Convert URL-safe dimension back (295-80R22.5 -> 295/80R22.5)
      const formattedDimension = dimension.replace(/-/g, '/');
      
      const tire = await this.marketDataService.getTireByReference(
        brand,
        diseno,
        formattedDimension,
      );

      if (!tire) {
        return {
          success: false,
          message: 'Tire not found',
          data: null,
        };
      }

      return {
        success: true,
        data: tire,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to retrieve tire',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Update averages for a specific tire based on user data
   * POST /market-data/update-averages
   * Body: { brand: "Continental", diseno: "HDR2", dimension: "295/80R22.5" }
   */
  @Post('update-averages')
  async updateTireAverages(@Body() body: { brand: string; diseno: string; dimension: string }) {
    try {
      const { brand, diseno, dimension } = body;

      if (!brand || !diseno || !dimension) {
        throw new HttpException(
          'brand, diseno, and dimension are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      await this.marketDataService.updateTireAverages(brand, diseno, dimension);

      const updatedTire = await this.marketDataService.getTireByReference(brand, diseno, dimension);

      return {
        success: true,
        message: 'Tire averages updated successfully',
        data: updatedTire,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to update tire averages',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Update all tire averages in the system
   * POST /market-data/update-all-averages
   */
  @Post('update-all-averages')
  async updateAllAverages() {
    try {
      const result = await this.marketDataService.updateAllTireAverages();
      
      return {
        success: true,
        message: `Updated ${result.updated} tires`,
        updated: result.updated,
        errors: result.errors,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to update all averages',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Update monthly price for a tire
   * PUT /market-data/price
   * Body: { brand: "Continental", diseno: "HDR2", dimension: "295/80R22.5", price: 450 }
   */
  @Put('price')
  async updateMonthlyPrice(
    @Body() body: { brand: string; diseno: string; dimension: string; price: number },
  ) {
    try {
      const { brand, diseno, dimension, price } = body;

      if (!brand || !diseno || !dimension || price === undefined) {
        throw new HttpException(
          'brand, diseno, dimension, and price are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (price < 0) {
        throw new HttpException('Price must be positive', HttpStatus.BAD_REQUEST);
      }

      const updatedTire = await this.marketDataService.updateMonthlyPrice(
        brand,
        diseno,
        dimension,
        price,
      );

      return {
        success: true,
        message: 'Price updated successfully',
        data: updatedTire,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to update price',
          error: error.message,
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get market insights and analytics
   * GET /market-data/insights
   */
  @Get('insights')
  async getMarketInsights() {
    try {
      const insights = await this.marketDataService.getMarketInsights();
      
      return {
        success: true,
        data: insights,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to retrieve market insights',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Search tires by brand
   * GET /market-data/search?brand=Continental
   */
  @Get('search')
  async searchTires(@Query('brand') brand?: string) {
    try {
      const where: any = {};
      
      if (brand) {
        where.brand = { contains: brand, mode: 'insensitive' };
      }

      // This would require adding a search method to the service
      // For now, return a simple response
      return {
        success: true,
        message: 'Search endpoint - implement custom search logic as needed',
        filters: { brand },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Search failed',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get all market tires with pagination
   * GET /market-data/all?page=1&limit=50
   */
  @Get('all')
  async getAllTires(
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '50',
  ) {
    try {
      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      // This would require pagination logic in the service
      return {
        success: true,
        message: 'Pagination endpoint - implement in service as needed',
        page: pageNum,
        limit: limitNum,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to retrieve tires',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}