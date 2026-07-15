import type { ProductPhoto } from "@noctella/shared";
import type { UnitOfWork } from "./unitOfWork";
import type { PhotoStorage } from "./photoStorage";
import { uploadProductPhoto } from "./products";

export enum ProductPhotoProcessingStatus { Processing="Processing", Ready="Ready", Failed="Failed" }
export interface ImageProcessor { process(input:{buffer:Buffer;mimetype:string;size:number}): Promise<{buffer:Buffer;mimetype:string;size:number}> }
export interface ProductPhotoStorage extends PhotoStorage { promoteProductPhoto?(photo: ProductPhoto): Promise<void>; cleanupTemporaryProductPhoto?(photo: ProductPhoto): Promise<void> }
export interface Clock { now(): Date }
export interface IdGenerator { id(): string }

export class UploadProductPhotoUseCase {
  constructor(private readonly uow: UnitOfWork, private readonly storage: ProductPhotoStorage) {}
  async execute(input:{ db:any; productId:string; file:{buffer:Buffer;mimetype:string;size:number}; altText?:string }) {
    return this.uow.run(({ repositories }) => uploadProductPhoto(repositories.db ?? input.db, input.productId, input.file, input.altText, this.storage));
  }
}
