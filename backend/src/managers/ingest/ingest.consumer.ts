import {
  InjectQueue,
  OnQueueError,
  OnQueueFailed,
  Process,
  Processor
} from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bull';
import { ImageEntryVariant } from 'picsur-shared/dist/dto/image-entry-variant.enum';
import {
  FileType,
  ImageFileType,
  SupportedFileTypeCategory
} from 'picsur-shared/dist/dto/mimes.dto';
import {
  AsyncFailable,
  Fail,
  FT,
  HasFailed,
  IsFailure,
  ThrowIfFailed
} from 'picsur-shared/dist/types';
import { ParseFileType } from 'picsur-shared/dist/util/parse-mime';
import { ImageDBService } from '../../collections/image-db/image-db.service';
import { ImageFileDBService } from '../../collections/image-db/image-file-db.service';
import { EImageBackend } from '../../database/entities/images/image.entity';
import { ImageConverterService } from '../image/image-converter.service';
import { ImageResult } from '../image/imageresult';

interface ImageIngestJobData {
  imageID: string;
  storeOriginal: boolean;
}
export type ImageIngestQueue = Queue<ImageIngestJobData>;
export type ImageIngestJob = Job<ImageIngestJobData>;

@Processor('image-ingest')
export class IngestConsumer {
  private readonly logger = new Logger(IngestConsumer.name);
  private i = 0;

  constructor(
    @InjectQueue('image-ingest') private readonly ingestQueue: Queue,
    private readonly imagesService: ImageDBService,
    private readonly imageFilesService: ImageFileDBService,
    private readonly imageConverter: ImageConverterService,
  ) {
    this.logger.log('Ingest consumer started');
    this.logger.error('Ingest consumer started');
  }

  // @Process('group')
  // async processJob(job: Job<GroupIngestJob>) {
  //   console.log('Received', job.data);
  //   await new Promise((resolve) => setTimeout(resolve, 4000));
  //   console.log('Done');
  //   return 'big chungus';
  // }

  @Process('image')
  async processImage(job: ImageIngestJob): Promise<EImageBackend> {
    const { imageID, storeOriginal } = job.data;

    job.failedReason = 'Not implemented';

    if (this.i === 0) {
      throw Fail(FT.Internal, undefined, 'oops');
    }

    // Already start the query for the image, we only need it when returning
    const imagePromise = this.imagesService.findOne(imageID, undefined);

    this.logger.verbose(
      `Ingesting image ${imageID} and store original: ${storeOriginal}`,
    );

    const ingestFile = ThrowIfFailed(
      await this.imageFilesService.getFile(imageID, ImageEntryVariant.INGEST),
    );

    const ingestFiletype = ThrowIfFailed(ParseFileType(ingestFile.filetype));

    const processed = ThrowIfFailed(
      await this.process(ingestFile.data, ingestFiletype),
    );

    const masterPromise = this.imageFilesService.setFile(
      imageID,
      ImageEntryVariant.MASTER,
      processed.image,
      processed.filetype,
    );

    const originalPromise = storeOriginal
      ? this.imageFilesService.migrateFile(
          imageID,
          ImageEntryVariant.INGEST,
          ImageEntryVariant.ORIGINAL,
        )
      : this.imageFilesService.deleteFile(imageID, ImageEntryVariant.INGEST);

    const results = await Promise.all([masterPromise, originalPromise]);
    results.map((r) => ThrowIfFailed(r));

    const image = ThrowIfFailed(await imagePromise);

    this.logger.verbose(`Ingested image ${imageID}`);

    return image;
  }

  public async process(
    image: Buffer,
    filetype: FileType,
  ): AsyncFailable<ImageResult> {
    if (filetype.category === SupportedFileTypeCategory.Image) {
      return await this.processStill(image, filetype);
    } else if (filetype.category === SupportedFileTypeCategory.Animation) {
      return await this.processAnimation(image, filetype);
    } else {
      return Fail(FT.SysValidation, 'Unsupported mime type');
    }
  }

  private async processStill(
    image: Buffer,
    filetype: FileType,
  ): AsyncFailable<ImageResult> {
    const outputFileType = ParseFileType(ImageFileType.QOI);
    if (HasFailed(outputFileType)) return outputFileType;

    return this.imageConverter.convert(image, filetype, outputFileType, {});
  }

  private async processAnimation(
    image: Buffer,
    filetype: FileType,
  ): AsyncFailable<ImageResult> {
    // Webps and gifs are stored as is for now
    return {
      image: image,
      filetype: filetype.identifier,
    };
  }

  @OnQueueError()
  async handleError(error: any) {
    if (IsFailure(error)) error.print(this.logger);
    else this.logger.error(error);
  }

  @OnQueueFailed()
  async handleFailed(job: Job, error: any) {
    if (IsFailure(error))
      error.print(this.logger, {
        prefix: `[JOB ${job.id}]`,
      });
    else this.logger.error(error);
  }
}
