/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Request-local derived bytes with one original-owner backing and explicit seal.
use super::{preparation_io::PreparationIo, request_backing::RequestBackingBuilder};
use maka_agent_facts::model::prompt_source::source::*;
use std::{
    io,
    io::Write,
    ops::Range,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct CaptureArena(Arc<Inner>);
// The optional prefix follows the request's own staging and active envelopes.
const RESIDENT_PREFIX_BYTES: usize = 1024 * 1024;
const INLINE_COPY_BYTES: usize = 32 * 1024;

pub(crate) struct ArenaAppend {
    arena: CaptureArena,
    _sequence: tokio::sync::OwnedMutexGuard<()>,
}
impl ArenaAppend {
    pub async fn position(&self) -> io::Result<u64> {
        self.arena.position().await
    }

    pub async fn with_writer<T: Send + 'static>(
        &self,
        write: impl FnOnce(&mut RequestBackingBuilder) -> io::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        self.arena.write_job(write).await
    }

    pub async fn write_buffer(
        &self,
        buffer: ChargedBuffer,
        used: usize,
    ) -> io::Result<ChargedBuffer> {
        self.arena
            .bounded_job(used, used, move |writer| {
                writer.write_all(&buffer.as_ref()[..used])?;
                Ok(buffer)
            })
            .await
    }
}
pub(crate) fn source_metadata_bytes(count: usize) -> io::Result<usize> {
    count
        .checked_mul(std::mem::size_of::<RangeSource>() + 2 * std::mem::size_of::<usize>())
        .ok_or_else(|| io::Error::other("arena source metadata size overflow"))
}
struct Inner {
    io: PreparationIo,
    identity: Arc<SourceIdentity>,
    builder: Mutex<Option<RequestBackingBuilder>>,
    published: AtomicU64,
    close_result: Mutex<Option<Result<(), Arc<io::Error>>>>,
    serial: Arc<tokio::sync::Mutex<()>>,
    access: Arc<tokio::sync::Mutex<()>>,
}
impl CaptureArena {
    pub fn metadata_bytes() -> usize {
        2 * std::mem::size_of::<usize>()
            + std::mem::size_of::<Inner>()
            + 2 * std::mem::size_of::<usize>()
            + PreparationIo::metadata_bytes()
            + 2 * std::mem::size_of::<usize>()
            + std::mem::size_of::<tokio::sync::Mutex<()>>()
            + 2 * std::mem::size_of::<usize>()
            + std::mem::size_of::<tokio::sync::Mutex<()>>()
    }

    pub(crate) fn reserve_prefix(
        preparation: &super::preparation::RequestPreparation,
        resources: &maka_model::ModelPreparationResources,
    ) -> io::Result<Option<maka_model::DirectoryLease>> {
        let policy = resources.policy();
        let capacity = RESIDENT_PREFIX_BYTES
            .min(policy.staging_bytes / 32)
            .min(policy.resident_bytes / 32);
        if capacity == 0 {
            return Ok(None);
        }
        match preparation.plan_directory(capacity) {
            Ok(lease) => Ok(Some(lease)),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::InvalidInput
                ) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub async fn new(
        io: PreparationIo,
        resident: Option<maka_model::DirectoryLease>,
    ) -> io::Result<Self> {
        let inner = Arc::new(Inner {
            io: io.clone(),
            identity: Arc::new(SourceIdentity),
            builder: Mutex::new(None),
            published: AtomicU64::new(0),
            close_result: Mutex::new(None),
            serial: Arc::new(tokio::sync::Mutex::new(())),
            access: Arc::new(tokio::sync::Mutex::new(())),
        });
        let worker = inner.clone();
        io.with_root_io(move || {
            let resource = worker
                .io
                .reserve_local_resource()
                .map_err(io::Error::other)?;
            let builder = RequestBackingBuilder::file(worker.io.clone(), resident, resource)?;
            *worker.builder.lock().expect("capture arena lock poisoned") = Some(builder);
            Ok(())
        })
        .await?;
        Ok(Self(inner))
    }

    /// The callback runs only in the original resource worker, with no state lock
    /// held during its I/O. Callers must serialize it with the capture sequence.
    pub fn with_writer_sync<T>(
        &self,
        write: impl FnOnce(&mut RequestBackingBuilder) -> io::Result<T>,
    ) -> io::Result<T> {
        let mut builder = self
            .0
            .builder
            .lock()
            .expect("capture arena lock poisoned")
            .take()
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "capture arena is not writable")
            })?;
        let result = write(&mut builder);
        *self.0.builder.lock().expect("capture arena lock poisoned") = Some(builder);
        result
    }

    /// One producer owns the complete contiguous append sequence. Metadata and
    /// labels must be reserved before emitting a continuous body through it.
    pub async fn begin_append(&self) -> ArenaAppend {
        ArenaAppend {
            arena: self.clone(),
            _sequence: self.0.serial.clone().lock_owned().await,
        }
    }

    pub async fn with_writer<T: Send + 'static>(
        &self,
        write: impl FnOnce(&mut RequestBackingBuilder) -> io::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        let _serial = self.0.serial.lock().await;
        self.write_job(write).await
    }

    async fn write_job<T: Send + 'static>(
        &self,
        write: impl FnOnce(&mut RequestBackingBuilder) -> io::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        self.bounded_job(0, usize::MAX, write).await
    }

    pub(super) async fn with_bounded_writer<T: Send + 'static>(
        &self,
        growth: usize,
        bytes: usize,
        write: impl FnOnce(&mut RequestBackingBuilder) -> io::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        let _serial = self.0.serial.lock().await;
        self.bounded_job(growth, bytes, write).await
    }

    async fn bounded_job<T: Send + 'static>(
        &self,
        growth: usize,
        bytes: usize,
        operation: impl FnOnce(&mut RequestBackingBuilder) -> io::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        let access = self.0.access.clone().lock_owned().await;
        if bytes <= INLINE_COPY_BYTES
            && let Some(builder) = self
                .0
                .builder
                .lock()
                .expect("capture arena lock poisoned")
                .as_mut()
            && builder.fits_resident(growth)
        {
            return operation(builder);
        }
        let arena = self.clone();
        self.0
            .io
            .with_local_io(move || {
                let _access = access;
                arena.with_writer_sync(operation)
            })
            .await
    }

    pub(crate) async fn position(&self) -> io::Result<u64> {
        let _access = self.0.access.lock().await;
        self.0
            .builder
            .lock()
            .expect("capture arena lock poisoned")
            .as_ref()
            .map(RequestBackingBuilder::position)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "capture arena is not writable")
            })
    }

    pub(crate) async fn resident_capacity(&self) -> io::Result<usize> {
        let _access = self.0.access.lock().await;
        self.0
            .builder
            .lock()
            .expect("capture arena lock poisoned")
            .as_ref()
            .map(RequestBackingBuilder::resident_capacity)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "capture arena is not writable")
            })
    }

    /// Internal fixed metadata reads may run while an append sequence consumes
    /// recipes from this same arena. This never publishes or mutates a range.
    pub async fn read_control_owned<const N: usize>(
        &self,
        offset: u64,
        owner: Arc<dyn Send + Sync>,
    ) -> io::Result<[u8; N]> {
        self.bounded_job(0, N, move |builder| {
            let _owner = owner;
            let mut bytes = [0; N];
            builder.read_exact_at(offset, &mut bytes)?;
            Ok(bytes)
        })
        .await
    }

    pub async fn append(
        &self,
        source: SourceBytes,
        budget: Arc<dyn SourceBudget>,
        cancellation: &CancellationToken,
    ) -> io::Result<Range<u64>> {
        let append = self.begin_append().await;
        let start = append.position().await?;
        let mut cursor = source.open(budget.clone());
        let mut buffer = budget.allocate(32 * 1024).await?;
        loop {
            if cancellation.is_cancelled() {
                return Err(crate::preparation_cancelled(
                    "capture arena append cancelled",
                ));
            }
            let read = cursor.read_chunk(buffer).await?;
            let used = read.bytes_read;
            let eof = read.eof;
            buffer = append.write_buffer(read.buffer, used).await?;
            if eof {
                break;
            }
            if used == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "arena input made no progress",
                ));
            }
        }
        let end = append.position().await?;
        Ok(start..end)
    }

    /// Internal immutable-prefix inspection is available before publication.
    pub fn inspect(&self, range: Range<u64>) -> SourceBytes {
        SourceBytes::Source(Arc::new(RangeSource {
            arena: self.clone(),
            range,
            inspection: true,
        }))
    }
    /// Provider sources become readable when their complete range has been sealed.
    pub fn pending(&self, range: Range<u64>) -> SourceBytes {
        SourceBytes::Source(Arc::new(RangeSource {
            arena: self.clone(),
            range,
            inspection: false,
        }))
    }
    /// Publish the flushed immutable prefix, keeping the same arena appendable.
    pub async fn seal(&self) -> io::Result<()> {
        let _serial = self.0.serial.lock().await;
        let access = self.0.access.clone().lock_owned().await;
        let arena = self.clone();
        self.0
            .io
            .with_root_io(move || {
                let _access = access;
                let length = arena.with_writer_sync(RequestBackingBuilder::seal_prefix)?;
                arena.0.published.store(length, Ordering::Release);
                Ok(())
            })
            .await
    }

    /// Spill a backing explicitly when the caller needs file capacity.
    pub async fn promote_to_file(&self) -> io::Result<()> {
        self.with_writer(RequestBackingBuilder::promote_to_file)
            .await
    }

    pub async fn close(&self) -> io::Result<()> {
        let _serial = self.0.serial.lock().await;
        let access = self.0.access.clone().lock_owned().await;
        let arena = self.clone();
        self.0
            .io
            .with_local_io(move || {
                let _access = access;
                if let Some(result) = arena
                    .0
                    .close_result
                    .lock()
                    .expect("capture arena lock poisoned")
                    .as_ref()
                {
                    return result
                        .clone()
                        .map_err(|error| io::Error::new(error.kind(), error));
                }
                let builder = arena
                    .0
                    .builder
                    .lock()
                    .expect("capture arena lock poisoned")
                    .take();
                let result = match builder {
                    Some(builder) => builder.abort_in_worker(),
                    None => Ok(()),
                }
                .map_err(Arc::new);
                *arena
                    .0
                    .close_result
                    .lock()
                    .expect("capture arena lock poisoned") = Some(result.clone());
                result.map_err(|error| io::Error::new(error.kind(), error))
            })
            .await
    }
}
struct RangeSource {
    arena: CaptureArena,
    range: Range<u64>,
    inspection: bool,
}
impl ByteSource for RangeSource {
    fn locator(&self) -> Option<SourceLocator> {
        Some(SourceLocator::Arena {
            identity: self.arena.0.identity.clone(),
            range: self.range.clone(),
        })
    }
    fn len(&self) -> Option<u64> {
        Some(self.range.end - self.range.start)
    }
    fn slice(&self, range: Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        if range.start > range.end || range.end > self.range.end - self.range.start {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "arena range exceeds frozen bytes",
            ));
        }
        Ok(Arc::new(Self {
            arena: self.arena.clone(),
            range: self.range.start + range.start..self.range.start + range.end,
            inspection: self.inspection,
        }))
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(Cursor {
            arena: self.arena.clone(),
            range: self.range.clone(),
            position: 0,
            inspection: self.inspection,
            _budget: budget,
        })
    }
}
struct Cursor {
    arena: CaptureArena,
    range: Range<u64>,
    position: u64,
    inspection: bool,
    _budget: Arc<dyn SourceBudget>,
}
impl ByteCursor for Cursor {
    fn read_chunk(&mut self, buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let available = usize::try_from(self.range.end - self.range.start - self.position)
                .unwrap_or(usize::MAX)
                .min(buffer.as_ref().len());
            if available == 0 && self.position != self.range.end - self.range.start {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "arena read has an empty buffer",
                ));
            }
            let offset = self.range.start + self.position;
            let arena = self.arena.clone();
            let end = self.range.end;
            let inspection = self.inspection;
            let buffer = self
                .arena
                .bounded_job(0, available, move |builder| {
                    if !inspection && end > arena.0.published.load(Ordering::Acquire) {
                        return Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            "capture arena range is not published",
                        ));
                    }
                    builder.read_buffer_at(offset, buffer, available, ())
                })
                .await?;
            self.position += available as u64;
            Ok(SourceRead {
                buffer,
                bytes_read: available,
                eof: self.position == self.range.end - self.range.start,
            })
        })
    }
}
