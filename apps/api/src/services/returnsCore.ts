import { createReturnApplicationContext } from "./returnApplicationContext";
import { approveReturnUseCase, authorizeReturnUseCase, cancelReturnUseCase, completeReturnUseCase, createReturnUseCase, getReturnDetailUseCase, getReturnEventsUseCase, getReturnReadinessUseCase, inspectReturnUseCase, listReturnsUseCase, markReturnInTransitUseCase, receiveReturnUseCase, rejectReturnUseCase, updateReturnUseCase } from "../use-cases/return/useCases";

export const createReturnRequest = (db: any, input: any) => createReturnUseCase(createReturnApplicationContext(db), input);
export const getReturnRequest = (db: any, id: string) => getReturnDetailUseCase(createReturnApplicationContext(db), id);
export const listReturnRequests = (db: any, q: any = {}) => listReturnsUseCase(createReturnApplicationContext(db), q);
export const updateReturnRequest = (db: any, id: string, input: any) => updateReturnUseCase(createReturnApplicationContext(db), id, input);
export const authorizeReturn = (db: any, id: string, input: any = {}) => authorizeReturnUseCase(createReturnApplicationContext(db), id, input);
export const rejectReturn = (db: any, id: string, input: any = {}) => rejectReturnUseCase(createReturnApplicationContext(db), id, input);
export const markReturnInTransit = (db: any, id: string, input: any = {}) => markReturnInTransitUseCase(createReturnApplicationContext(db), id, input);
export const receiveReturn = (db: any, id: string, input: any = {}) => receiveReturnUseCase(createReturnApplicationContext(db), id, input);
export const inspectReturnItem = (db: any, id: string, input: any) => inspectReturnUseCase(createReturnApplicationContext(db), id, input);
export const approveReturn = (db: any, id: string, input: any = {}) => approveReturnUseCase(createReturnApplicationContext(db), id, input);
export const completeReturn = (db: any, id: string) => completeReturnUseCase(createReturnApplicationContext(db), id);
export const cancelReturn = (db: any, id: string, input: any = {}) => cancelReturnUseCase(createReturnApplicationContext(db), id, input);
export const getReturnReadiness = (db: any, id: string) => getReturnReadinessUseCase(createReturnApplicationContext(db), id);
export const getReturnEvents = (db: any, id: string) => getReturnEventsUseCase(createReturnApplicationContext(db), id);
