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

//! Request-local derived bytes; normal allocation admission never chooses spill.

use super::preparation_io::PreparationIo;
use maka_agent_facts::model::prompt_source::source::ChargedBuffer;
use maka_capabilities::model_preparation::DirectoryLease;
use maka_event_log::root_store::{WorkEffectLease, create_request_file};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    ops::Range,
};

/// The request capture owner retains this writer across jobs. Every file
/// operation runs on its original resource worker; errors/cancellation await abort.
pub(crate) struct RequestBackingBuilder {
    storage: Option<Building>,
    length: u64,
    sealed: u64,
}
struct Resident {
    bytes: Vec<u8>,
    lease: DirectoryLease,
}

struct Building {
    file: File,
    resource: WorkEffectLease,
    io: PreparationIo,
    resident: Option<Resident>,
}

impl RequestBackingBuilder {
    pub(crate) fn file(
        io: PreparationIo,
        resident: Option<DirectoryLease>,
        resource: WorkEffectLease,
    ) -> io::Result<Self> {
        let opened = (|| {
            let resident = resident
                .map(|lease| -> io::Result<_> {
                    let mut bytes = Vec::new();
                    bytes
                        .try_reserve_exact(lease.capacity())
                        .map_err(io::Error::other)?;
                    if bytes.capacity() > lease.capacity() {
                        return Err(io::Error::other(
                            "backing allocator exceeds resident reservation",
                        ));
                    }
                    Ok(Resident { bytes, lease })
                })
                .transpose()?;
            let file = create_request_file()?;
            Ok((file, resident))
        })();
        match opened {
            Ok((file, resident)) => Ok(Self {
                storage: Some(Building {
                    file,
                    resource,
                    io,
                    resident,
                }),
                length: 0,
                sealed: 0,
            }),
            Err(error) => {
                resource.finish(Ok(()));
                Err(error)
            }
        }
    }

    pub(super) fn abort_in_worker(mut self) -> io::Result<()> {
        let Building {
            file, resource, io, ..
        } = self.storage.take().expect("unfinished backing");
        io.close_file_in_worker(file, resource)
    }

    pub(crate) fn seal_prefix(&mut self) -> io::Result<u64> {
        self.flush()?;
        self.sealed = self.length;
        Ok(self.sealed)
    }

    /// Write the reserved prefix once. Keep it authoritative until the write succeeds.
    pub(crate) fn promote_to_file(&mut self) -> io::Result<()> {
        let storage = self.storage.as_mut().expect("unfinished backing");
        if let Some(resident) = &storage.resident {
            storage.file.seek(SeekFrom::Start(0))?;
            storage.file.write_all(&resident.bytes)?;
            storage.resident = None;
        }
        Ok(())
    }

    pub(super) fn resident_capacity(&self) -> usize {
        self.storage
            .as_ref()
            .expect("unfinished backing")
            .resident
            .as_ref()
            .map_or(0, |resident| resident.lease.capacity())
    }

    pub(super) fn fits_resident(&self, growth: usize) -> bool {
        self.storage
            .as_ref()
            .expect("unfinished backing")
            .resident
            .as_ref()
            .is_some_and(|resident| growth <= resident.lease.capacity() - resident.bytes.len())
    }

    /// The returned copy retains the original work custody.
    pub(crate) fn read_buffer_at(
        &mut self,
        offset: u64,
        mut buffer: ChargedBuffer,
        size: usize,
        read_owner: impl Send + Sync + 'static,
    ) -> io::Result<ChargedBuffer> {
        self.read_exact_at(offset, &mut buffer.as_mut()[..size])?;
        let storage = self.storage.as_ref().expect("unfinished backing");
        Ok(buffer.retain_owner((storage.io.clone(), read_owner)))
    }

    pub(crate) fn position(&self) -> u64 {
        self.length
    }

    pub(crate) fn append_bytes(&mut self, bytes: &[u8]) -> io::Result<Range<u64>> {
        let start = self.length;
        self.write_all(bytes)?;
        Ok(start..self.length)
    }

    /// Rewind unsealed trailing bytes appended since `position` (e.g. a deduplicated media write).
    pub(crate) fn truncate_unsealed(&mut self, position: u64) -> io::Result<()> {
        if position < self.sealed || position > self.length {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cannot truncate past sealed prefix or length",
            ));
        }
        let storage = self.storage.as_mut().expect("unfinished backing");
        if let Some(resident) = &mut storage.resident {
            resident.bytes.truncate(position as usize);
        } else {
            storage.file.set_len(position)?;
            storage.file.seek(SeekFrom::Start(position))?;
        }
        self.length = position;
        Ok(())
    }

    /// Reserve a new zero-filled table in this backing; file regions stay sparse.
    pub(crate) fn reserve_zeroed(&mut self, bytes: u64) -> io::Result<Range<u64>> {
        let start = self.length;
        let end = start
            .checked_add(bytes)
            .ok_or_else(|| invalid("request backing offset overflows"))?;
        if usize::try_from(bytes).is_ok_and(|growth| self.fits_resident(growth)) {
            self.storage
                .as_mut()
                .unwrap()
                .resident
                .as_mut()
                .unwrap()
                .bytes
                .resize(end as usize, 0);
        } else {
            self.promote_to_file()?;
            self.storage.as_mut().unwrap().file.set_len(end)?;
        }
        self.length = end;
        Ok(start..end)
    }

    /// Scratch/fixed-record regions share the same file. This never extends a
    /// region, allocates a directory, or changes the append position.
    pub(crate) fn write_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
        let range = checked_range(offset, bytes.len(), self.length)?;
        if offset < self.sealed && !bytes.is_empty() {
            return Err(invalid("cannot overwrite a published request prefix"));
        }
        let storage = self.storage.as_mut().expect("unfinished backing");
        if let Some(resident) = &mut storage.resident {
            resident.bytes[range.start as usize..range.end as usize].copy_from_slice(bytes);
            Ok(())
        } else {
            storage.file.seek(SeekFrom::Start(offset))?;
            storage.file.write_all(bytes)
        }
    }

    pub(crate) fn read_exact_at(&mut self, offset: u64, target: &mut [u8]) -> io::Result<()> {
        let range = checked_range(offset, target.len(), self.length)?;
        let storage = self.storage.as_mut().expect("unfinished backing");
        if let Some(resident) = &storage.resident {
            target.copy_from_slice(&resident.bytes[range.start as usize..range.end as usize]);
            Ok(())
        } else {
            storage.file.seek(SeekFrom::Start(offset))?;
            storage.file.read_exact(target)
        }
    }
}

impl Write for RequestBackingBuilder {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.length
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| invalid("request backing offset overflows"))?;
        let written = if self.fits_resident(bytes.len()) {
            self.storage
                .as_mut()
                .unwrap()
                .resident
                .as_mut()
                .unwrap()
                .bytes
                .extend_from_slice(bytes);
            bytes.len()
        } else {
            self.promote_to_file()?;
            let file = &mut self.storage.as_mut().unwrap().file;
            file.seek(SeekFrom::Start(self.length))?;
            file.write(bytes)?
        };
        self.length += written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        let storage = self.storage.as_mut().expect("unfinished backing");
        if storage.resident.is_none() {
            storage.file.flush()?;
        }
        Ok(())
    }
}
impl Drop for RequestBackingBuilder {
    fn drop(&mut self) {
        if let Some(Building {
            file, resource, io, ..
        }) = self.storage.take()
        {
            io.close_file_on_worker(file, resource);
        }
    }
}

fn checked_range(offset: u64, bytes: usize, length: u64) -> io::Result<Range<u64>> {
    let end = offset
        .checked_add(bytes as u64)
        .ok_or_else(|| invalid("request backing range overflows"))?;
    let range = offset..end;
    validate_range(&range, length)?;
    Ok(range)
}
fn validate_range(range: &Range<u64>, length: u64) -> io::Result<()> {
    if range.start > range.end || range.end > length {
        return Err(invalid("request backing range is outside published bytes"));
    }
    Ok(())
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
