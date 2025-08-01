import { Binary, UUID } from '../binary';
import type { Document } from '../bson';
import { Code } from '../code';
import * as constants from '../constants';
import { DBRef, type DBRefLike, isDBRefLike } from '../db_ref';
import { Decimal128 } from '../decimal128';
import { Double } from '../double';
import { BSONError } from '../error';
import { Int32 } from '../int_32';
import { Long } from '../long';
import { MaxKey } from '../max_key';
import { MinKey } from '../min_key';
import { ObjectId } from '../objectid';
import { BSONRegExp } from '../regexp';
import { BSONSymbol } from '../symbol';
import { Timestamp } from '../timestamp';
import { BSONDataView, ByteUtils } from '../utils/byte_utils';
import { validateUtf8 } from '../validate_utf8';

/** @public */
export interface DeserializeOptions {
  /**
   * when deserializing a Long return as a BigInt.
   * @defaultValue `false`
   */
  useBigInt64?: boolean;
  /**
   * when deserializing a Long will fit it into a Number if it's smaller than 53 bits.
   * @defaultValue `true`
   */
  promoteLongs?: boolean;
  /**
   * when deserializing a Binary will return it as a node.js Buffer instance.
   * @defaultValue `false`
   */
  promoteBuffers?: boolean;
  /**
   * when deserializing will promote BSON values to their Node.js closest equivalent types.
   * @defaultValue `true`
   */
  promoteValues?: boolean;
  /**
   * allow to specify if there what fields we wish to return as unserialized raw buffer.
   * @defaultValue `null`
   */
  fieldsAsRaw?: Document;
  /**
   * return BSON regular expressions as BSONRegExp instances.
   * @defaultValue `false`
   */
  bsonRegExp?: boolean;
  /**
   * allows the buffer to be larger than the parsed BSON object.
   * @defaultValue `false`
   */
  allowObjectSmallerThanBufferSize?: boolean;
  /**
   * Offset into buffer to begin reading document from
   * @defaultValue `0`
   */
  index?: number;

  raw?: boolean;
  /** Allows for opt-out utf-8 validation for all keys or
   * specified keys. Must be all true or all false.
   *
   * @example
   * ```js
   * // disables validation on all keys
   *  validation: { utf8: false }
   *
   * // enables validation only on specified keys a, b, and c
   *  validation: { utf8: { a: true, b: true, c: true } }
   *
   *  // disables validation only on specified keys a, b
   *  validation: { utf8: { a: false, b: false } }
   * ```
   */
  validation?: { utf8: boolean | Record<string, true> | Record<string, false> };
}

// Internal long versions
const JS_INT_MAX_LONG = Long.fromNumber(constants.JS_INT_MAX);
const JS_INT_MIN_LONG = Long.fromNumber(constants.JS_INT_MIN);

export function internalDeserialize(
  buffer: Uint8Array,
  options: DeserializeOptions,
  isArray?: boolean
): Document {
  options = options == null ? {} : options;
  const index = options && options.index ? options.index : 0;
  // Read the document size
  const size =
    buffer[index] |
    (buffer[index + 1] << 8) |
    (buffer[index + 2] << 16) |
    (buffer[index + 3] << 24);

  if (size < 5) {
    throw new BSONError(`bson size must be >= 5, is ${size}`);
  }

  if (options.allowObjectSmallerThanBufferSize && buffer.length < size) {
    throw new BSONError(`buffer length ${buffer.length} must be >= bson size ${size}`);
  }

  if (!options.allowObjectSmallerThanBufferSize && buffer.length !== size) {
    throw new BSONError(`buffer length ${buffer.length} must === bson size ${size}`);
  }

  if (size + index > buffer.byteLength) {
    throw new BSONError(
      `(bson size ${size} + options.index ${index} must be <= buffer length ${buffer.byteLength})`
    );
  }

  // Illegal end value
  if (buffer[index + size - 1] !== 0) {
    throw new BSONError(
      "One object, sized correctly, with a spot for an EOO, but the EOO isn't 0x00"
    );
  }

  // Start deserialization
  return deserializeObject(buffer, index, options, isArray);
}

const allowedDBRefKeys = /^\$ref$|^\$id$|^\$db$/;

function deserializeObject(
  buffer: Uint8Array,
  index: number,
  options: DeserializeOptions,
  isArray = false
) {
  const fieldsAsRaw = options['fieldsAsRaw'] == null ? null : options['fieldsAsRaw'];

  // Return raw bson buffer instead of parsing it
  const raw = options['raw'] == null ? false : options['raw'];

  // Return BSONRegExp objects instead of native regular expressions
  const bsonRegExp = typeof options['bsonRegExp'] === 'boolean' ? options['bsonRegExp'] : false;

  // Controls the promotion of values vs wrapper classes
  const promoteBuffers = options.promoteBuffers ?? false;
  const promoteLongs = options.promoteLongs ?? true;
  const promoteValues = options.promoteValues ?? true;
  const useBigInt64 = options.useBigInt64 ?? false;

  if (useBigInt64 && !promoteValues) {
    throw new BSONError('Must either request bigint or Long for int64 deserialization');
  }

  if (useBigInt64 && !promoteLongs) {
    throw new BSONError('Must either request bigint or Long for int64 deserialization');
  }

  // Ensures default validation option if none given
  const validation = options.validation == null ? { utf8: true } : options.validation;

  // Shows if global utf-8 validation is enabled or disabled
  let globalUTFValidation = true;
  // Reflects utf-8 validation setting regardless of global or specific key validation
  let validationSetting: boolean;
  // Set of keys either to enable or disable validation on
  const utf8KeysSet = new Set();

  // Check for boolean uniformity and empty validation option
  const utf8ValidatedKeys = validation.utf8;
  if (typeof utf8ValidatedKeys === 'boolean') {
    validationSetting = utf8ValidatedKeys;
  } else {
    globalUTFValidation = false;
    const utf8ValidationValues = Object.keys(utf8ValidatedKeys).map(function (key) {
      return utf8ValidatedKeys[key];
    });
    if (utf8ValidationValues.length === 0) {
      throw new BSONError('UTF-8 validation setting cannot be empty');
    }
    if (typeof utf8ValidationValues[0] !== 'boolean') {
      throw new BSONError('Invalid UTF-8 validation option, must specify boolean values');
    }
    validationSetting = utf8ValidationValues[0];
    // Ensures boolean uniformity in utf-8 validation (all true or all false)
    if (!utf8ValidationValues.every(item => item === validationSetting)) {
      throw new BSONError('Invalid UTF-8 validation option - keys must be all true or all false');
    }
  }

  // Add keys to set that will either be validated or not based on validationSetting
  if (!globalUTFValidation) {
    for (const key of Object.keys(utf8ValidatedKeys)) {
      utf8KeysSet.add(key);
    }
  }

  // Set the start index
  const startIndex = index;

  // Validate that we have at least 4 bytes of buffer
  if (buffer.length < 5) throw new BSONError('corrupt bson message < 5 bytes long');

  // Read the document size
  const size =
    buffer[index++] | (buffer[index++] << 8) | (buffer[index++] << 16) | (buffer[index++] << 24);

  // Ensure buffer is valid size
  if (size < 5 || size > buffer.length) throw new BSONError('corrupt bson message');

  // Create holding object
  const object: Document = isArray ? [] : {};
  // Used for arrays to skip having to perform utf8 decoding
  let arrayIndex = 0;
  const done = false;

  let isPossibleDBRef = isArray ? false : null;

  // While we have more left data left keep parsing
  const dataview = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  while (!done) {
    // Read the type
    const elementType = buffer[index++];

    // If we get a zero it's the last byte, exit
    if (elementType === 0) break;

    // Get the start search index
    let i = index;
    // Locate the end of the c string
    while (buffer[i] !== 0x00 && i < buffer.length) {
      i++;
    }

    // If are at the end of the buffer there is a problem with the document
    if (i >= buffer.byteLength) throw new BSONError('Bad BSON Document: illegal CString');

    // Represents the key
    const name = isArray ? arrayIndex++ : ByteUtils.toUTF8(buffer, index, i);

    // console.log('name:', name);

    // shouldValidateKey is true if the key should be validated, false otherwise
    let shouldValidateKey = true;
    if (globalUTFValidation || utf8KeysSet.has(name)) {
      shouldValidateKey = validationSetting;
    } else {
      shouldValidateKey = !validationSetting;
    }

    if (isPossibleDBRef !== false && (name as string)[0] === '$') {
      isPossibleDBRef = allowedDBRefKeys.test(name as string);
    }
    let value;

    index = i + 1;

    // console.log('elementType:', elementType);

    if (elementType === constants.BSON_DATA_STRING) {
      const stringSize =
        buffer[index++] |
        (buffer[index++] << 8) |
        (buffer[index++] << 16) |
        (buffer[index++] << 24);
      if (
        stringSize <= 0 ||
        stringSize > buffer.length - index ||
        buffer[index + stringSize - 1] !== 0
      ) {
        throw new BSONError('bad string length in bson');
      }
      value = getValidatedString(buffer, index, index + stringSize - 1, shouldValidateKey);
      index = index + stringSize;
    } else if (elementType === constants.BSON_DATA_OID) {
      const oid = ByteUtils.allocate(12);
      oid.set(buffer.subarray(index, index + 12));
      value = new ObjectId(oid);
      index = index + 12;
    } else if (elementType === constants.BSON_DATA_INT && promoteValues === false) {
      value = new Int32(
        buffer[index++] | (buffer[index++] << 8) | (buffer[index++] << 16) | (buffer[index++] << 24)
      );
    } else if (elementType === constants.BSON_DATA_INT) {
      value =
        buffer[index++] |
        (buffer[index++] << 8) |
        (buffer[index++] << 16) |
        (buffer[index++] << 24);
    } else if (elementType === constants.BSON_DATA_NUMBER && promoteValues === false) {
      value = new Double(dataview.getFloat64(index, true));
      index = index + 8;
    } else if (elementType === constants.BSON_DATA_NUMBER) {
      value = dataview.getFloat64(index, true);
      if (isNaN(value)) {
        // index = index + stringSize;
        value = 'NaN';
      }
      if (value === Infinity) {
        // index = index + stringSize;
        value = 'Infinity';
      }
      if (value === -Infinity) {
        // index = index + stringSize;
        value = '-Infinity';
      }
      index = index + 8;
    } else if (elementType === constants.BSON_DATA_DATE) {
      const lowBits =
        buffer[index++] |
        (buffer[index++] << 8) |
        (buffer[index++] << 16) |
        (buffer[index++] << 24);
      const highBits =
        buffer[index++] |
        (buffer[index++] << 8) |
        (buffer[index++] << 16) |
        (buffer[index++] << 24);
      value = new Date(new Long(lowBits, highBits).toNumber());
    } else if (elementType === constants.BSON_DATA_BOOLEAN) {
      if (buffer[index] !== 0 && buffer[index] !== 1)
        throw new BSONError('illegal boolean type value');
      value = buffer[index++] === 1;
    } else if (elementType === constants.BSON_DATA_OBJECT) {
      const _index = index;
      const objectSize =
        buffer[index] |
        (buffer[index + 1] << 8) |
        (buffer[index + 2] << 16) |
        (buffer[index + 3] << 24);
      if (objectSize <= 0 || objectSize > buffer.length - index)
        throw new BSONError('bad embedded document length in bson');

      // We have a raw value
      if (raw) {
        value = buffer.slice(index, index + objectSize);
      } else {
        let objectOptions = options;
        if (!globalUTFValidation) {
          objectOptions = { ...options, validation: { utf8: shouldValidateKey } };
        }
        value = deserializeObject(buffer, _index, objectOptions, false);
      }

      index = index + objectSize;
    } else if (elementType === constants.BSON_DATA_ARRAY) {
      const _index = index;
      const objectSize =
        buffer[index] |
        (buffer[index + 1] << 8) |
        (buffer[index + 2] << 16) |
        (buffer[index + 3] << 24);
      let arrayOptions: DeserializeOptions = options;

      // Stop index
      const stopIndex = index + objectSize;

      // All elements of array to be returned as raw bson
      if (fieldsAsRaw && fieldsAsRaw[name]) {
        arrayOptions = { ...options, raw: true };
      }

      if (!globalUTFValidation) {
        arrayOptions = { ...arrayOptions, validation: { utf8: shouldValidateKey } };
      }
      value = deserializeObject(buffer, _index, arrayOptions, true);
      index = index + objectSize;

      if (buffer[index - 1] !== 0) throw new BSONError('invalid array terminator byte');
      if (index !== stopIndex) throw new BSONError('corrupted array bson');
    } else if (elementType === constants.BSON_DATA_UNDEFINED) {
      value = undefined;
    } else if (elementType === constants.BSON_DATA_NULL) {
      value = null;
    } else if (elementType === constants.BSON_DATA_LONG) {
      // Unpack the low and high bits
      const dataview = BSONDataView.fromUint8Array(buffer.subarray(index, index + 8));

      const lowBits =
        buffer[index++] |
        (buffer[index++] << 8) |
        (buffer[index++] << 16) |
        (buffer[index++] << 24);
      const highBits =
        buffer[index++] |
        (buffer[index++] << 8) |
        (buffer[index++] << 16) |
        (buffer[index++] << 24);
      const long = new Long(lowBits, highBits);
      if (useBigInt64) {
        value = dataview.getBigInt64(0, true);
      } else if (promoteLongs && promoteValues === true) {
        // Promote the long if possible
        value =
          long.lessThanOrEqual(JS_INT_MAX_LONG) && long.greaterThanOrEqual(JS_INT_MIN_LONG)
            ? long.toNumber()
            : long;
      } else {
        value = long;
      }
    } else if (elementType === constants.BSON_DATA_DECIMAL128) {
      // Buffer to contain the decimal bytes
      const bytes = ByteUtils.allocate(16);
      // Copy the next 16 bytes into the bytes buffer
      bytes.set(buffer.subarray(index, index + 16), 0);
      // Update index
      index = index + 16;
      // Assign the new Decimal128 value
      value = new Decimal128(bytes);
    } else if (elementType === constants.BSON_DATA_BINARY) {
      let binarySize =
        buffer[index++] |
        (buffer[index++] << 8) |
        (buffer[index++] << 16) |
        (buffer[index++] << 24);
      const totalBinarySize = binarySize;
      const subType = buffer[index++];

      // Did we have a negative binary size, throw
      if (binarySize < 0) throw new BSONError('Negative binary type element size found');

      // Is the length longer than the document
      if (binarySize > buffer.byteLength)
        throw new BSONError('Binary type size larger than document size');

      // Decode as raw Buffer object if options specifies it
      if (buffer['slice'] != null) {
        // If we have subtype 2 skip the 4 bytes for the size
        if (subType === Binary.SUBTYPE_BYTE_ARRAY) {
          binarySize =
            buffer[index++] |
            (buffer[index++] << 8) |
            (buffer[index++] << 16) |
            (buffer[index++] << 24);
          if (binarySize < 0)
            throw new BSONError('Negative binary type element size found for subtype 0x02');
          if (binarySize > totalBinarySize - 4)
            throw new BSONError('Binary type with subtype 0x02 contains too long binary size');
          if (binarySize < totalBinarySize - 4)
            throw new BSONError('Binary type with subtype 0x02 contains too short binary size');
        }

        if (promoteBuffers && promoteValues) {
          value = ByteUtils.toLocalBufferType(buffer.slice(index, index + binarySize));
        } else {
          value = new Binary(buffer.slice(index, index + binarySize), subType);
          if (subType === constants.BSON_BINARY_SUBTYPE_UUID_NEW && UUID.isValid(value)) {
            value = value.toUUID();
          }
        }
      } else {
        const _buffer = ByteUtils.allocate(binarySize);
        // If we have subtype 2 skip the 4 bytes for the size
        if (subType === Binary.SUBTYPE_BYTE_ARRAY) {
          binarySize =
            buffer[index++] |
            (buffer[index++] << 8) |
            (buffer[index++] << 16) |
            (buffer[index++] << 24);
          if (binarySize < 0)
            throw new BSONError('Negative binary type element size found for subtype 0x02');
          if (binarySize > totalBinarySize - 4)
            throw new BSONError('Binary type with subtype 0x02 contains too long binary size');
          if (binarySize < totalBinarySize - 4)
            throw new BSONError('Binary type with subtype 0x02 contains too short binary size');
        }

        // Copy the data
        for (i = 0; i < binarySize; i++) {
          _buffer[i] = buffer[index + i];
        }

        if (promoteBuffers && promoteValues) {
          value = _buffer;
        } else {
          value = new Binary(buffer.slice(index, index + binarySize), subType);
          if (subType === constants.BSON_BINARY_SUBTYPE_UUID_NEW && UUID.isValid(value)) {
            value = value.toUUID();
          }
        }
      }

      // Update the index
      index = index + binarySize;
    } else if (elementType === constants.BSON_DATA_REGEXP && bsonRegExp === false) {
      // Get the start search index
      i = index;
      // Locate the end of the c string
      while (buffer[i] !== 0x00 && i < buffer.length) {
        i++;
      }
      // If are at the end of the buffer there is a problem with the document
      if (i >= buffer.length) throw new BSONError('Bad BSON Document: illegal CString');
      // Return the C string
      const source = ByteUtils.toUTF8(buffer, index, i);
      // Create the regexp
      index = i + 1;

      // Get the start search index
      i = index;
      // Locate the end of the c string
      while (buffer[i] !== 0x00 && i < buffer.length) {
        i++;
      }
      // If are at the end of the buffer there is a problem with the document
      if (i >= buffer.length) throw new BSONError('Bad BSON Document: illegal CString');
      // Return the C string
      const regExpOptions = ByteUtils.toUTF8(buffer, index, i);
      index = i + 1;

      // For each option add the corresponding one for javascript
      const optionsArray = new Array(regExpOptions.length);

      // Parse options
      for (i = 0; i < regExpOptions.length; i++) {
        switch (regExpOptions[i]) {
          case 'm':
            optionsArray[i] = 'm';
            break;
          case 's':
            optionsArray[i] = 'g';
            break;
          case 'i':
            optionsArray[i] = 'i';
            break;
        }
      }

      value = new RegExp(source, optionsArray.join(''));
    } else if (elementType === constants.BSON_DATA_REGEXP && bsonRegExp === true) {
      // Get the start search index
      i = index;
      // Locate the end of the c string
      while (buffer[i] !== 0x00 && i < buffer.length) {
        i++;
      }
      // If are at the end of the buffer there is a problem with the document
      if (i >= buffer.length) throw new BSONError('Bad BSON Document: illegal CString');
      // Return the C string
      const source = ByteUtils.toUTF8(buffer, index, i);
      index = i + 1;

      // Get the start search index
      i = index;
      // Locate the end of the c string
      while (buffer[i] !== 0x00 && i < buffer.length) {
        i++;
      }
      // If are at the end of the buffer there is a problem with the document
      if (i >= buffer.length) throw new BSONError('Bad BSON Document: illegal CString');
      // Return the C string
      const regExpOptions = ByteUtils.toUTF8(buffer, index, i);
      index = i + 1;

      // Set the object
      value = new BSONRegExp(source, regExpOptions);
    } else if (elementType === constants.BSON_DATA_SYMBOL) {
      const stringSize =
        buffer[index++] |
        (buffer[index++] << 8) |
        (buffer[index++] << 16) |
        (buffer[index++] << 24);
      if (
        stringSize <= 0 ||
        stringSize > buffer.length - index ||
        buffer[index + stringSize - 1] !== 0
      ) {
        throw new BSONError('bad string length in bson');
      }
      const symbol = getValidatedString(buffer, index, index + stringSize - 1, shouldValidateKey);
      value = promoteValues ? symbol : new BSONSymbol(symbol);
      index = index + stringSize;
    } else if (elementType === constants.BSON_DATA_TIMESTAMP) {
      // We intentionally **do not** use bit shifting here
      // Bit shifting in javascript coerces numbers to **signed** int32s
      // We need to keep i, and t unsigned
      const i =
        buffer[index++] +
        buffer[index++] * (1 << 8) +
        buffer[index++] * (1 << 16) +
        buffer[index++] * (1 << 24);
      const t =
        buffer[index++] +
        buffer[index++] * (1 << 8) +
        buffer[index++] * (1 << 16) +
        buffer[index++] * (1 << 24);

      value = new Timestamp({ i, t });
    } else if (elementType === constants.BSON_DATA_MIN_KEY) {
      value = new MinKey();
    } else if (elementType === constants.BSON_DATA_MAX_KEY) {
      value = new MaxKey();
    } else if (elementType === constants.BSON_DATA_CODE) {
      const stringSize =
        buffer[index++] |
        (buffer[index++] << 8) |
        (buffer[index++] << 16) |
        (buffer[index++] << 24);
      if (
        stringSize <= 0 ||
        stringSize > buffer.length - index ||
        buffer[index + stringSize - 1] !== 0
      ) {
        throw new BSONError('bad string length in bson');
      }
      const functionString = getValidatedString(
        buffer,
        index,
        index + stringSize - 1,
        shouldValidateKey
      );

      value = new Code(functionString);

      // Update parse index position
      index = index + stringSize;
    } else if (elementType === constants.BSON_DATA_CODE_W_SCOPE) {
      const totalSize =
        buffer[index++] |
        (buffer[index++] << 8) |
        (buffer[index++] << 16) |
        (buffer[index++] << 24);

      // Element cannot be shorter than totalSize + stringSize + documentSize + terminator
      if (totalSize < 4 + 4 + 4 + 1) {
        throw new BSONError('code_w_scope total size shorter minimum expected length');
      }

      // Get the code string size
      const stringSize =
        buffer[index++] |
        (buffer[index++] << 8) |
        (buffer[index++] << 16) |
        (buffer[index++] << 24);
      // Check if we have a valid string
      if (
        stringSize <= 0 ||
        stringSize > buffer.length - index ||
        buffer[index + stringSize - 1] !== 0
      ) {
        throw new BSONError('bad string length in bson');
      }

      // Javascript function
      const functionString = getValidatedString(
        buffer,
        index,
        index + stringSize - 1,
        shouldValidateKey
      );
      // Update parse index position
      index = index + stringSize;
      // Parse the element
      const _index = index;
      // Decode the size of the object document
      const objectSize =
        buffer[index] |
        (buffer[index + 1] << 8) |
        (buffer[index + 2] << 16) |
        (buffer[index + 3] << 24);
      // Decode the scope object
      const scopeObject = deserializeObject(buffer, _index, options, false);
      // Adjust the index
      index = index + objectSize;

      // Check if field length is too short
      if (totalSize < 4 + 4 + objectSize + stringSize) {
        throw new BSONError('code_w_scope total size is too short, truncating scope');
      }

      // Check if totalSize field is too long
      if (totalSize > 4 + 4 + objectSize + stringSize) {
        throw new BSONError('code_w_scope total size is too long, clips outer document');
      }

      value = new Code(functionString, scopeObject);
    } else if (elementType === constants.BSON_DATA_DBPOINTER) {
      // Get the code string size
      const stringSize =
        buffer[index++] |
        (buffer[index++] << 8) |
        (buffer[index++] << 16) |
        (buffer[index++] << 24);
      // Check if we have a valid string
      if (
        stringSize <= 0 ||
        stringSize > buffer.length - index ||
        buffer[index + stringSize - 1] !== 0
      )
        throw new BSONError('bad string length in bson');
      // Namespace
      if (validation != null && validation.utf8) {
        if (!validateUtf8(buffer, index, index + stringSize - 1)) {
          throw new BSONError('Invalid UTF-8 string in BSON document');
        }
      }
      const namespace = ByteUtils.toUTF8(buffer, index, index + stringSize - 1);
      // Update parse index position
      index = index + stringSize;

      // Read the oid
      const oidBuffer = ByteUtils.allocate(12);
      oidBuffer.set(buffer.subarray(index, index + 12), 0);
      const oid = new ObjectId(oidBuffer);

      // Update the index
      index = index + 12;

      // Upgrade to DBRef type
      value = new DBRef(namespace, oid);
    } else {
      throw new BSONError(
        `Detected unknown BSON type ${elementType.toString(16)} for fieldname "${name}"`
      );
    }
    if (name === '__proto__') {
      Object.defineProperty(object, name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
      });
    } else {
      object[name] = value;
    }
  }

  // Check if the deserialization was against a valid array/object
  if (size !== index - startIndex) {
    if (isArray) throw new BSONError('corrupt array bson');
    throw new BSONError('corrupt object bson');
  }

  // if we did not find "$ref", "$id", "$db", or found an extraneous $key, don't make a DBRef
  if (!isPossibleDBRef) return object;

  if (isDBRefLike(object)) {
    const copy = Object.assign({}, object) as Partial<DBRefLike>;
    delete copy.$ref;
    delete copy.$id;
    delete copy.$db;
    return new DBRef(object.$ref, object.$id, object.$db, copy);
  }

  return object;
}

function getValidatedString(
  buffer: Uint8Array,
  start: number,
  end: number,
  shouldValidateUtf8: boolean
) {
  const value = ByteUtils.toUTF8(buffer, start, end);
  // if utf8 validation is on, do the check
  if (shouldValidateUtf8) {
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) === 0xfffd) {
        if (!validateUtf8(buffer, start, end)) {
          throw new BSONError('Invalid UTF-8 string in BSON document');
        }
        break;
      }
    }
  }
  return value;
}
