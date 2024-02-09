const fs = require('fs');

// Global variables for tracking performance and frame rate
const TARGET_FRAME_DURATION = 16.666; // Target frame duration for 60 FPS (in milliseconds)
const CYCLES_PER_FRAME = 29780; // Total CPU cycles per frame (this is an example value)
const CYCLES_PER_SCANLINE = 113; // CPU cycles per scanline (this is an example value)
const PPU_CYCLES_PER_SCANLINE = CYCLES_PER_SCANLINE * 3; // PPU cycles per scanline

let lastFpsUpdateTime = 0;
let fpsCounter = 0;
let frameCounter = 0;
let lastFrameTime = performance.now();
let frameRateAdjustment = 0;

// Define the Memory
const Memory = {
    data: new Uint8Array(0x10000), // 64KB of memory
    ppuMemory: new Uint8Array(0x4000), // 16KB of memory for PPU

    read: function(address) {
        address &= 0xFFFF; // Ensure address is a 16-bit value

        // Internal RAM and its mirrors ($0000-$1FFF)
        if (address < 0x2000) {
            return this.data[address & 0x07FF];
        }

        // PPU registers and their mirrors ($2000-$3FFF)
        if (address >= 0x2000 && address < 0x4000) {
            return this.data[address & 0x2007];
        }

        // APU and I/O registers ($4000-$401F)
        if (address >= 0x4000 && address <= 0x401F) {
            return this.data[address];
        }

        // Cartridge space (PRG ROM, battery-backed RAM, mapper registers) ($4020-$FFFF)
        if (address >= 0x4020) {
            return this.data[address];
        }

        return 0;
    },

    write: function(address, value) {
        address &= 0xFFFF; // Ensure address is a 16-bit value
        value &= 0xFF; // Ensure value is an 8-bit value

        // Internal RAM and its mirrors ($0000-$1FFF)
        if (address < 0x2000) {
            this.data[address & 0x07FF] = value;
            return;
        }

        // PPU registers and their mirrors ($2000-$3FFF)
        if (address >= 0x2000 && address < 0x4000) {
            this.data[address & 0x2007] = value;
            return;
        }

        // APU and I/O registers ($4000-$401F)
        if (address >= 0x4000 && address <= 0x401F) {
            this.data[address] = value;
            return;
        }

        // Cartridge space (PRG ROM, battery-backed RAM, mapper registers) ($4020-$FFFF)
        if (address >= 0x4020) {
            this.data[address] = value;
            return;
        }
    },

    ppuRead: function(address) {
        address &= 0x3FFF; // Ensure address is within PPU memory range
        return this.ppuMemory[address];
    },

    ppuWrite: function(address, value) {
        address &= 0x3FFF; // Ensure address is within PPU memory range
        this.ppuMemory[address] = value;
    }
};

// Define the CPU
const CPU = {
    // Registers
    A: 0x00,  // Accumulator
    X: 0x00,  // X Register
    Y: 0x00,  // Y Register
    PC: 0x8000, // Program Counter
    SP: 0xFD, // Stack Pointer

    // Reset button
    reset: function() {
        CPU.A = 0x00;
        CPU.X = 0x00;
        CPU.Y = 0x00;
        CPU.PC = 0x8000;
        CPU.SP = 0xFD;
    },

    // Status Flags
    Flags: {
        BreakFlag: false,       // B
        CarryFlag: false,       // C
        DecimalModeFlag: false, // D
        InterruptFlag: false,   // I
        NegativeFlag: false,    // N
        OverflowFlag: false,    // V/O
        ZeroFlag: false,        // Z
    },

    getStatusFlags: function() {
        return (CPU.Flags.CarryFlag ? 0x01 : 0) |
               (CPU.Flags.ZeroFlag ? 0x02 : 0) |
               (CPU.Flags.InterruptFlag ? 0x04 : 0) |
               (CPU.Flags.DecimalModeFlag ? 0x08 : 0) |
               (CPU.Flags.BreakFlag ? 0x10 : 0) |
               (CPU.Flags.OverflowFlag ? 0x40 : 0) |
               (CPU.Flags.NegativeFlag ? 0x80 : 0);
    },

    setFlags: function(value) {
        CPU.Flags.CarryFlag = (value & 0x01) !== 0;
        CPU.Flags.ZeroFlag = (value & 0x02) !== 0;
        CPU.Flags.InterruptFlag = (value & 0x04) !== 0;
        CPU.Flags.DecimalModeFlag = (value & 0x08) !== 0;
        CPU.Flags.BreakFlag = (value & 0x10) !== 0;
        CPU.Flags.OverflowFlag = (value & 0x40) !== 0;
        CPU.Flags.NegativeFlag = (value & 0x80) !== 0;
    },

    readMemory: function(address) {
        return Memory.read(address);
    },

    writeMemory: function(address, value) {
        Memory.write(address, value);
    },

    // Addressing Modes
    addressing_modes: {
        Absolute: function() {
            const lowByte = CPU.readMemory(CPU.PC);
            CPU.PC += 1;
            const highByte = CPU.readMemory(CPU.PC);
            CPU.PC += 1;
            return (highByte << 8) | lowByte;
        },
        AbsoluteX: function() {
            const baseAddress = CPU.addressing_modes.Absolute.call(this);
            return (baseAddress + CPU.X) & 0xFFFF; // Wraparound handled for 16-bit address space
        },
        AbsoluteY: function() {
            const baseAddress = CPU.addressing_modes.Absolute.call(this);
            return (baseAddress + CPU.Y) & 0xFFFF; // Wraparound handled for 16-bit address space
        },
        Accumulator: function() {
            return CPU.A;
        },
        Immediate: function() {
            const operand = CPU.readMemory(CPU.PC);
            CPU.PC += 1;
            return operand;
        },
        IndX: function() {
            const zeroPageAddress = (CPU.readMemory(CPU.PC) + CPU.X) & 0xFF;
            CPU.PC += 1;
            const lowByte = CPU.readMemory(zeroPageAddress);
            const highByte = CPU.readMemory((zeroPageAddress + 1) & 0xFF); // Wraparound for zero-page
            return (highByte << 8) | lowByte;
        },
        IndY: function() {
            const zeroPageAddress = CPU.readMemory(CPU.PC);
            CPU.PC += 1;
            const lowByte = CPU.readMemory(zeroPageAddress);
            const highByte = CPU.readMemory((zeroPageAddress + 1) & 0xFF); // Wraparound for zero-page
            const baseAddress = (highByte << 8) | lowByte;
            return (baseAddress + CPU.Y) & 0xFFFF; // Wraparound handled for 16-bit address space
        },
        Indirect: function() {
            const lowByte = CPU.readMemory(CPU.PC);
            CPU.PC += 1;
            const highByte = CPU.readMemory(CPU.PC);
            CPU.PC += 1;
            const pointer = (highByte << 8) | lowByte;
            const effectiveLowByte = CPU.readMemory(pointer);
            const effectiveHighByte = CPU.readMemory((pointer & 0xFF00) | ((pointer + 1) & 0xFF)); // 6502 bug emulation for JMP
            return (effectiveHighByte << 8) | effectiveLowByte;
        },
        Relative: function() {
            const offset = CPU.readMemory(CPU.PC);
            CPU.PC += 1;
            if (offset < 0x80) {
                return CPU.PC + offset;
            } else {
                return CPU.PC + offset - 0x100; // Negative offset
            }
        },
        ZeroPage: function() {
            const address = CPU.readMemory(CPU.PC);
            CPU.PC += 1;
            return address;
        },
        ZeroPageX: function() {
            const address = (CPU.readMemory(CPU.PC) + CPU.X) & 0xFF;
            CPU.PC += 1;
            return address;
        },
        ZeroPageY: function() {
            const address = (CPU.readMemory(CPU.PC) + CPU.Y) & 0xFF;
            CPU.PC += 1;
            return address;
        }
    },

    instruction_set: {
        ADC: function(operand) {
            const carry = CPU.Flags.CarryFlag ? 1 : 0;
            const result = CPU.A + operand + carry;
            
            // Update flags
            CPU.Flags.CarryFlag = result > 0xFF;
            CPU.Flags.ZeroFlag = (result & 0xFF) === 0;
            CPU.Flags.NegativeFlag = (result & 0x80) !== 0;
            CPU.Flags.OverflowFlag = (((CPU.A ^ result) & (operand ^ result)) & 0x80) !== 0;
        
            // Store the result in the accumulator
            CPU.A = result & 0xFF;
        },
        AND: function(operand) {
            // Perform bitwise AND
            CPU.A &= operand;
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.A === 0);
            CPU.Flags.NegativeFlag = (CPU.A & 0x80) !== 0;
        },
        ASL_A: function() {
            CPU.Flags.CarryFlag = (CPU.A & 0x80) !== 0; // Set carry flag to bit 7 of the accumulator
            CPU.A = (CPU.A << 1) & 0xFF; // Shift left and keep within 8 bits
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.A === 0); // Set if the result is 0
            CPU.Flags.NegativeFlag = (CPU.A & 0x80) !== 0; // Set if the high bit of the result is set
        },
        ASL: function(address) {
            let value = CPU.readMemory(address);
            CPU.Flags.CarryFlag = (value & 0x80) !== 0; // Set carry flag to bit 7 of the value
            value = (value << 1) & 0xFF; // Shift left and keep within 8 bits
        
            // Write the new value back to memory
            CPU.writeMemory(address, value);
        
            // Update flags
            CPU.Flags.ZeroFlag = (value === 0); // Set if the result is 0
            CPU.Flags.NegativeFlag = (value & 0x80) !== 0; // Set if the high bit of the result is set
        },
        BCC: function(operand) {
            if (!CPU.Flags.CarryFlag) {
                CPU.PC = operand;
            }
        },
        BCS: function(operand) {
            if (CPU.Flags.CarryFlag) {
                CPU.PC = operand;
            }
        },
        BEQ: function(operand) {
            if (CPU.Flags.ZeroFlag) {
                CPU.PC = operand;
            }
        },
        BNE: function(operand) {
            if (!CPU.Flags.ZeroFlag) {
                CPU.PC = operand;
            }
        },
        BMI: function(operand) {
            if (CPU.Flags.NegativeFlag) {
                CPU.PC = operand;
            }
        },
        BPL: function(operand) {
            if (!CPU.Flags.NegativeFlag) {
                CPU.PC = operand;
            }
        },
        BVS: function(operand) {
            if (CPU.Flags.OverflowFlag) {
                CPU.PC = operand;
            }
        },
        BVC: function(operand) {
            if (!CPU.Flags.OverflowFlag) {
                CPU.PC = operand;
            }
        },
        BIT: function(operand) {
            const value = CPU.readMemory(operand);
        
            // Update the Zero flag (Z flag)
            CPU.Flags.ZeroFlag = (CPU.A & value) === 0;
        
            // Update the Overflow flag (V flag) - Bit 6 of the value
            CPU.Flags.OverflowFlag = (value & 0x40) !== 0;
        
            // Update the Negative flag (N flag) - Bit 7 of the value
            CPU.Flags.NegativeFlag = (value & 0x80) !== 0;
        },
        BRK: function() {
            // Increment PC to simulate pushing the next instruction's address onto the stack
            CPU.PC += 1;
        
            // Push PC (high byte, then low byte) onto the stack
            CPU.writeMemory(0x0100 + CPU.SP, (CPU.PC >> 8) & 0xFF);
            CPU.SP = (CPU.SP - 1) & 0xFF;
            CPU.writeMemory(0x0100 + CPU.SP, CPU.PC & 0xFF);
            CPU.SP = (CPU.SP - 1) & 0xFF;
        
            // Push processor status onto the stack
            let status = CPU.getStatusFlags();
            status |= 0x10; // Set break flag
            CPU.writeMemory(0x0100 + CPU.SP, status);
            CPU.SP = (CPU.SP - 1) & 0xFF;
        
            // Set the Interrupt flag to prevent further IRQs
            CPU.Flags.InterruptFlag = true;
        
            // Load the interrupt vector into the PC
            const lowByte = CPU.readMemory(0xFFFE);
            const highByte = CPU.readMemory(0xFFFF);
            CPU.PC = (highByte << 8) | lowByte;
        },
        CLC: function() {
            CPU.Flags.CarryFlag = false;
        },
        CLD: function() {
            CPU.Flags.DecimalModeFlag = false;
        },
        CLI: function() {
            CPU.Flags.InterruptFlag = false;
        },
        CLV: function() {
            CPU.Flags.OverflowFlag = false;
        },
        CMP: function(operand) {
            const result = CPU.A - operand;
        
            // Set the Carry flag if A >= operand
            CPU.Flags.CarryFlag = (CPU.A >= operand);
        
            // Set the Zero flag if A == operand
            CPU.Flags.ZeroFlag = ((result & 0xFF) === 0);
        
            // Set the Negative flag based on the result's high bit
            CPU.Flags.NegativeFlag = (result & 0x80) !== 0;
        },
        CPX: function(operand) {
            const result = CPU.X - operand;
        
            // Set the Carry flag if X >= operand
            CPU.Flags.CarryFlag = (CPU.X >= operand);
        
            // Set the Zero flag if X == operand
            CPU.Flags.ZeroFlag = ((result & 0xFF) === 0);
        
            // Set the Negative flag based on the result's high bit
            CPU.Flags.NegativeFlag = (result & 0x80) !== 0;
        },
        CPY: function(operand) {
            const result = CPU.Y - operand;
        
            // Set the Carry flag if Y >= operand
            CPU.Flags.CarryFlag = (CPU.Y >= operand);
        
            // Set the Zero flag if Y == operand
            CPU.Flags.ZeroFlag = ((result & 0xFF) === 0);
        
            // Set the Negative flag based on the result's high bit
            CPU.Flags.NegativeFlag = (result & 0x80) !== 0;
        },
        DEC: function(address) {
            let value = CPU.readMemory(address) - 1;
        
            // Ensure the value wraps around in the 8-bit range
            value &= 0xFF;
        
            // Write the new value back to memory
            CPU.writeMemory(address, value);
        
            // Set the Zero flag if the result is 0
            CPU.Flags.ZeroFlag = (value === 0);
        
            // Set the Negative flag based on the result's high bit
            CPU.Flags.NegativeFlag = (value & 0x80) !== 0;
        },
        DEX: function() {
            CPU.X = (CPU.X - 1) & 0xFF; // Decrement X and wrap around 8-bit boundary
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.X === 0);
            CPU.Flags.NegativeFlag = (CPU.X & 0x80) !== 0;
        },
        DEY: function() {
            CPU.Y = (CPU.Y - 1) & 0xFF; // Decrement Y and wrap around 8-bit boundary
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.Y === 0);
            CPU.Flags.NegativeFlag = (CPU.Y & 0x80) !== 0;
        },
        EOR: function(operand) {
            // Perform bitwise XOR between the accumulator and the operand
            CPU.A ^= operand;
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.A === 0);        // Set if the result is 0
            CPU.Flags.NegativeFlag = (CPU.A & 0x80) !== 0; // Set if the high bit of the result is set
        },
        INC: function(address) {
            let value = (CPU.readMemory(address) + 1) & 0xFF; // Increment and wrap around 8-bit boundary
        
            // Write the new value back to memory
            CPU.writeMemory(address, value);
        
            // Update flags
            CPU.Flags.ZeroFlag = (value === 0); // Set if the result is 0
            CPU.Flags.NegativeFlag = (value & 0x80) !== 0; // Set if the high bit of the result is set
        },
        INX: function() {
            CPU.X = (CPU.X + 1) & 0xFF; // Increment X and wrap around 8-bit boundary
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.X === 0);
            CPU.Flags.NegativeFlag = (CPU.X & 0x80) !== 0;
        },
        INY: function() {
            CPU.Y = (CPU.Y + 1) & 0xFF; // Increment Y and wrap around 8-bit boundary
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.Y === 0);
            CPU.Flags.NegativeFlag = (CPU.Y & 0x80) !== 0;
        },
        JMP_ABS: function(address) {
            CPU.PC = address;
        },
        JMP_IND: function(address) {
            const lowByte = CPU.readMemory(address);
            const highByteAddress = (address & 0xFF00) | ((address + 1) & 0xFF);
            const highByte = CPU.readMemory(highByteAddress);
        
            CPU.PC = (highByte << 8) | lowByte;
        },
        JSR: function(address) {
            // Push the return address onto the stack. The return address is one less than the address of the next instruction.
            let returnAddress = CPU.PC - 1;
            CPU.writeMemory(0x0100 + CPU.SP, (returnAddress >> 8) & 0xFF); // Push high byte
            CPU.SP = (CPU.SP - 1) & 0xFF;
            CPU.writeMemory(0x0100 + CPU.SP, returnAddress & 0xFF); // Push low byte
            CPU.SP = (CPU.SP - 1) & 0xFF;
        
            // Set the program counter to the target address
            CPU.PC = address;
        },
        LDA: function(operand) {
            CPU.A = operand; // Load the operand into the accumulator
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.A === 0);
            CPU.Flags.NegativeFlag = (CPU.A & 0x80) !== 0;
        },
        LDX: function(operand) {
            CPU.X = operand; // Load the operand into the X register
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.X === 0); // Set if the X register is 0
            CPU.Flags.NegativeFlag = (CPU.X & 0x80) !== 0; // Set if the high bit of the X register is set
        },
        LDY: function(operand) {
            CPU.Y = operand; // Load the operand into the Y register
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.Y === 0); // Set if the Y register is 0
            CPU.Flags.NegativeFlag = (CPU.Y & 0x80) !== 0; // Set if the high bit of the Y register is set
        },
        LSR_A: function() {
            // Shift right the accumulator
            CPU.Flags.CarryFlag = (CPU.A & 0x01) !== 0; // Set carry flag to bit 0 of the accumulator
            CPU.A >>= 1; // Logical shift right
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.A === 0); // Set if the result is 0
            CPU.Flags.NegativeFlag = false; // Always cleared
        },
        LSR: function(address) {
            let value = CPU.readMemory(address);
        
            // Shift right the value
            CPU.Flags.CarryFlag = (value & 0x01) !== 0; // Set carry flag to bit 0 of the value
            value >>= 1; // Logical shift right
        
            // Write the new value back to memory
            CPU.writeMemory(address, value);
        
            // Update flags
            CPU.Flags.ZeroFlag = (value === 0); // Set if the result is 0
            CPU.Flags.NegativeFlag = false; // Always cleared
        },
        NOP: function() {
            // Do nothing
        },
        ORA: function(operand) {
            // Perform bitwise OR between the accumulator and the operand
            CPU.A |= operand;
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.A === 0);        // Set if the result is 0
            CPU.Flags.NegativeFlag = (CPU.A & 0x80) !== 0; // Set if the high bit of the result is set
        },
        PHA: function() {
            CPU.writeMemory(0x0100 + CPU.SP, CPU.A); // Push A onto the stack
            CPU.SP = (CPU.SP - 1) & 0xFF;
        },
        PHP: function() {
            let status = CPU.getStatusFlags() | 0x10; // Set the break flag for the push
            CPU.writeMemory(0x0100 + CPU.SP, status); // Push processor status onto the stack
            CPU.SP = (CPU.SP - 1) & 0xFF;
        },
        PLA: function() {
            CPU.SP = (CPU.SP + 1) & 0xFF;
            CPU.A = CPU.readMemory(0x0100 + CPU.SP); // Pull the top of the stack into A
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.A === 0);
            CPU.Flags.NegativeFlag = (CPU.A & 0x80) !== 0;
        },
        PLP: function() {
            CPU.SP = (CPU.SP + 1) & 0xFF;
            let status = CPU.readMemory(0x0100 + CPU.SP); // Pull the top of the stack into processor status
            CPU.setFlags(status);
        },
        ROL_A: function() {
            let carry = CPU.Flags.CarryFlag ? 1 : 0;
            CPU.Flags.CarryFlag = (CPU.A & 0x80) !== 0; // Set carry flag to bit 7 of the accumulator
            CPU.A = ((CPU.A << 1) | carry) & 0xFF; // Rotate left
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.A === 0); // Set if the result is 0
            CPU.Flags.NegativeFlag = (CPU.A & 0x80) !== 0; // Set if the high bit of the result is set
        },
        ROL: function(address) {
            let value = CPU.readMemory(address);
            let carry = CPU.Flags.CarryFlag ? 1 : 0;
            CPU.Flags.CarryFlag = (value & 0x80) !== 0; // Set carry flag to bit 7 of the value
            value = ((value << 1) | carry) & 0xFF; // Rotate left
        
            // Write the new value back to memory
            CPU.writeMemory(address, value);
        
            // Update flags
            CPU.Flags.ZeroFlag = (value === 0); // Set if the result is 0
            CPU.Flags.NegativeFlag = (value & 0x80) !== 0; // Set if the high bit of the result is set
        },
        ROR_A: function() {
            let carry = CPU.Flags.CarryFlag ? 0x80 : 0; // Set carry to bit 7 if carry flag is set
            CPU.Flags.CarryFlag = (CPU.A & 0x01) !== 0; // Set carry flag to bit 0 of the accumulator
            CPU.A = (CPU.A >> 1) | carry; // Rotate right
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.A === 0); // Set if the result is 0
            CPU.Flags.NegativeFlag = (CPU.A & 0x80) !== 0; // Set if the high bit of the result is set
        },
        ROR: function(address) {
            let value = CPU.readMemory(address);
            let carry = CPU.Flags.CarryFlag ? 0x80 : 0; // Set carry to bit 7 if carry flag is set
            CPU.Flags.CarryFlag = (value & 0x01) !== 0; // Set carry flag to bit 0 of the value
            value = (value >> 1) | carry; // Rotate right
        
            // Write the new value back to memory
            CPU.writeMemory(address, value);
        
            // Update flags
            CPU.Flags.ZeroFlag = (value === 0); // Set if the result is 0
            CPU.Flags.NegativeFlag = (value & 0x80) !== 0; // Set if the high bit of the result is set
        },
        RTI: function() {
            // Pull processor status from the stack
            CPU.SP = (CPU.SP + 1) & 0xFF;
            let status = CPU.readMemory(0x0100 + CPU.SP);
            CPU.setFlags(status);
        
            // Pull program counter from the stack
            CPU.SP = (CPU.SP + 1) & 0xFF;
            let lo = CPU.readMemory(0x0100 + CPU.SP);
            CPU.SP = (CPU.SP + 1) & 0xFF;
            let hi = CPU.readMemory(0x0100 + CPU.SP);
            CPU.PC = (hi << 8) | lo;
        },
        RTS: function() {
            // Pull program counter from the stack
            CPU.SP = (CPU.SP + 1) & 0xFF;
            let lo = CPU.readMemory(0x0100 + CPU.SP);
            CPU.SP = (CPU.SP + 1) & 0xFF;
            let hi = CPU.readMemory(0x0100 + CPU.SP);
        
            // Set the program counter to the address from the stack, then increment it
            CPU.PC = ((hi << 8) | lo) + 1;
        },
        SBC: function(operand) {
            let carry = CPU.Flags.CarryFlag ? 0 : 1;
            let temp = CPU.A - operand - carry;
        
            // Set the Overflow flag
            CPU.Flags.OverflowFlag = (((CPU.A ^ temp) & 0x80) !== 0) && (((CPU.A ^ operand) & 0x80) !== 0);
        
            // Set the Carry flag
            CPU.Flags.CarryFlag = temp >= 0;
        
            // Keep result within 8 bits
            temp &= 0xFF;
        
            // Update flags
            CPU.Flags.ZeroFlag = (temp === 0);        // Set if the result is 0
            CPU.Flags.NegativeFlag = (temp & 0x80) !== 0; // Set if the high bit of the result is set
        
            // Update the accumulator
            CPU.A = temp;
        },
        SEC: function() {
            CPU.Flags.CarryFlag = true; // Set the Carry flag
        },
        SED: function() {
            CPU.Flags.DecimalModeFlag = true; // Set the Decimal Mode flag
        },
        SEI: function() {
            CPU.Flags.InterruptFlag = true; // Set the Interrupt Disable flag
        },
        STA: function(address) {
            CPU.writeMemory(address, CPU.A); // Store the accumulator at the specified address
        },
        STX: function(address) {
            CPU.writeMemory(address, CPU.X); // Store the X register at the specified address
        },
        STY: function(address) {
            CPU.writeMemory(address, CPU.Y); // Store the Y register at the specified address
        },
        TAX: function() {
            CPU.X = CPU.A; // Transfer A to X
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.X === 0);
            CPU.Flags.NegativeFlag = (CPU.X & 0x80) !== 0;
        },
        TAY: function() {
            CPU.Y = CPU.A; // Transfer A to Y
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.Y === 0);
            CPU.Flags.NegativeFlag = (CPU.Y & 0x80) !== 0;
        },
        TSX: function() {
            CPU.X = CPU.SP; // Transfer SP to X
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.X === 0);
            CPU.Flags.NegativeFlag = (CPU.X & 0x80) !== 0;
        },
        TXA: function() {
            CPU.A = CPU.X; // Transfer X to A
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.A === 0);
            CPU.Flags.NegativeFlag = (CPU.A & 0x80) !== 0;
        },
        TXS: function() {
            CPU.SP = CPU.X; // Transfer X to SP
        },
        TYA: function() {
            CPU.A = CPU.Y; // Transfer Y to A
        
            // Update flags
            CPU.Flags.ZeroFlag = (CPU.A === 0);
            CPU.Flags.NegativeFlag = (CPU.A & 0x80) !== 0;
        },
    },
    
    // Decode and execute next instruction
    decodeAndExecute: function () {
        const opcode = CPU.readMemory(CPU.PC);
        CPU.PC += 1; // Increment the program counter to point to the next instruction
        
        switch (opcode) {
            case 0x69: // ADC #n -- Immediate
                operand = CPU.addressing_modes.Immediate();
                CPU.instruction_set.ADC(operand);
                break;
            case 0x6D: // ADC nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.ADC(operand);
                break;
            case 0x65: // ADC n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.ADC(operand);
                break;
            case 0x61: // ADC (n,X) -- Ind X
                operand = CPU.addressing_modes.IndX();
                CPU.instruction_set.ADC(operand);
                break;
            case 0x71: // ADC (n),Y -- Ind Y
                operand = CPU.addressing_modes.IndY();
                CPU.instruction_set.ADC(operand);
                break;
            case 0x75: // ADC n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.ADC(operand);
                break;
            case 0x7D: // ADC nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.ADC(operand);
                break;
            case 0x79: // ADC NN,Y -- Absolute Y
                operand = CPU.addressing_modes.AbsoluteY();
                CPU.instruction_set.ADC(operand);
                break;
            
            case 0x29: // AND #n -- Immediate
                operand = CPU.addressing_modes.Immediate();
                CPU.instruction_set.AND(operand);
                break;
            case 0x2D: // AND nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.AND(operand);
                break;
            case 0x25: // AND n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.AND(operand);
                break;
            case 0x21: // AND (n,X) -- Ind Y
                operand = CPU.addressing_modes.IndX();
                CPU.instruction_set.AND(operand);
                break;
            case 0x31: // AND (n),Y -- Ind X
                operand = CPU.addressing_modes.IndY();
                CPU.instruction_set.AND(operand);
                break;
            case 0x35: // AND n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.AND(operand);
                break;
            case 0x3D: // AND nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.AND(operand);
                break;
            case 0x39: // AND nn,Y -- Absolute Y
                operand = CPU.addressing_modes.AbsoluteY();
                CPU.instruction_set.AND(operand);
                break;

            case 0x0E: // ASL nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.ASL(operand);
                break;
            case 0x06: // ASL n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.ASL(operand);
                break;
            case 0x0A: // ASL A -- Accumulator
                operand = CPU.A;
                CPU.instruction_set.ASL_A();
                break;
            case 0x16: // ASL n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.ASL(operand);
                break;
            case 0x1E: // ASL nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.ASL(operand);
                break;

            case 0x90: // BCC n -- Relative
                operand = CPU.addressing_modes.Relative();
                CPU.instruction_set.BCC(operand);
                break;
            case 0xB0: // BCS n -- Relative
                operand = CPU.addressing_modes.Relative();
                CPU.instruction_set.BCS(operand);
                break;
            case 0xF0: // BEQ n -- Relative
                operand = CPU.addressing_modes.Relative();
                CPU.instruction_set.BEQ(operand);
                break;
            case 0xD0: // BNE n -- Relative
                operand = CPU.addressing_modes.Relative();
                CPU.instruction_set.BNE(operand);
                break;
            case 0x30: // BMI n -- Relative
                operand = CPU.addressing_modes.Relative();
                CPU.instruction_set.BMI(operand);
                break;
            case 0x10: // BPL n -- Relative
                operand = CPU.addressing_modes.Relative();
                CPU.instruction_set.BPL(operand);
                break;
            case 0x50: // BVS n -- Relative
                operand = CPU.addressing_modes.Relative();
                CPU.instruction_set.BVS(operand);
                break;
            case 0x70: // BVS n -- Relative
                operand = CPU.addressing_modes.Relative();
                CPU.instruction_set.BVS(operand);
                break;

            case 0x2C: // BIT nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.BIT(operand);
                break;
            case 0x24: // BIT n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.BIT(operand);
                break;

            case 0x00: // BRK -- None
                CPU.instruction_set.BRK();
                break;

            case 0x18: // CLC -- None
                CPU.instruction_set.CLC();
                break;
            case 0xD8: // CLD -- None
                CPU.instruction_set.CLD();
                break;
            case 0x58: // CLI -- None
                CPU.instruction_set.CLI();
                break;
            case 0xB8: // CLV -- None
                CPU.instruction_set.CLV();
                break;

            case 0xC9: // CMP #n -- Immediate
                operand = CPU.addressing_modes.Immediate();
                CPU.instruction_set.CMP(operand);
                break;
            case 0xCD: // CMP nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.CMP(operand);
                break;
            case 0xC5: // CMP n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.CMP(operand);
                break;
            case 0xC1: // CMP (n,X) -- Ind X
                operand = CPU.addressing_modes.IndX();
                CPU.instruction_set.CMP(operand);
                break;
            case 0xD1: // CMP (n),Y -- Ind Y
                operand = CPU.addressing_modes.IndY();
                CPU.instruction_set.CMP(operand);
                break;
            case 0xD5: // CMP n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.CMP(operand);
                break;
            case 0xDD: // CMP nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.CMP(operand);
                break;
            case 0xD9: // CMP nn,Y -- Absolute Y
                operand = CPU.addressing_modes.AbsoluteY();
                CPU.instruction_set.CMP(operand);
                break;

            case 0xE0: // CPX #n -- Immediate
                operand = CPU.addressing_modes.Immediate();
                CPU.instruction_set.CPX(operand);
                break;
            case 0xEC: // CPX nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.CPX(operand);
                break;
            case 0xE4: // CPX n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.CPX(operand);
                break;

            case 0xC0: // CPY #n -- Immediate
                operand = CPU.addressing_modes.Immediate();
                CPU.instruction_set.CPY(operand);
                break;
            case 0xCC: // CPY nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.CPY(operand);
                break;
            case 0xC4: // CPY n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.CPY(operand);
                break;

            case 0xCE: // DEC nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.DEC(operand);
                break;
            case 0xC6: // DEC n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.DEC(operand);
                break;
            case 0xD6: // DEC n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.DEC(operand);
                break;
            case 0xDE: // DEC nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.DEC(operand);
                break;
                
            case 0xCA: // DEX -- None
                CPU.instruction_set.DEX();
                break;
            case 0x88: // DEY -- None
                CPU.instruction_set.DEY();
                break;

            case 0x49: // EOR #n -- Immediate
                operand = CPU.addressing_modes.Immediate();
                CPU.instruction_set.EOR(operand);
                break;
            case 0x4D: // EOR nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.EOR(operand);
                break;
            case 0x45: // EOR n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.EOR(operand);
                break;
            case 0x41: // EOR (n,X) -- Ind X
                operand = CPU.addressing_modes.IndX();
                CPU.instruction_set.EOR(operand);
                break;
            case 0x51: // EOR (n),Y -- Ind Y
                operand = CPU.addressing_modes.IndY();
                CPU.instruction_set.EOR(operand);
                break;
            case 0x55: // EOR n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.EOR(operand);
                break;
            case 0x5D: // EOR nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.EOR(operand);
                break;
            case 0x59: // EOR nn,Y -- Absolute Y
                operand = CPU.addressing_modes.AbsoluteY();
                CPU.instruction_set.EOR(operand);
                break;

            case 0xEE: // INC nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.INC(operand);
                break;
            case 0xE6: // INC n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.INC(operand);
                break;
            case 0xF6: // INC n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.INC(operand);
                break;
            case 0xFE: // INC nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.INC(operand);
                break;

            case 0xE8: // INX -- None
                CPU.instruction_set.INX();
                break;
            case 0xC8: // INY -- None
                CPU.instruction_set.INY();
                break;

            case 0x4C: // JMP nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.JMP_ABS(operand);
                break;
            case 0x6C: // JMP (nn) -- Indirect
                operand = CPU.addressing_modes.Indirect();
                CPU.instruction_set.JMP_IND(operand);
                break;

            case 0x20: // JSR nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.JSR(operand);
                break;

            case 0xA9: // LDA #n -- Immediate
                operand = CPU.addressing_modes.Immediate();
                CPU.instruction_set.LDA(operand);
                break;
            case 0xAD: // LDA nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.LDA(operand);
                break;
            case 0xA5: // LDA n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.LDA(operand);
                break;
            case 0xA1: // LDA (n,X) -- Ind X
                operand = CPU.addressing_modes.IndX();
                CPU.instruction_set.LDA(operand);
                break;
            case 0xB1: // LDA (n),Y -- Ind Y
                operand = CPU.addressing_modes.IndY();
                CPU.instruction_set.LDA(operand);
                break;
            case 0xB5: // LDA n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.LDA(operand);
                break;
            case 0xBD: // LDA nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.LDA(operand);
                break;
            case 0xB9: // LDA nn,Y -- Absolute Y
                operand = CPU.addressing_modes.AbsoluteY();
                CPU.instruction_set.LDA(operand);
                break;

            case 0xA2: // LDX #n -- Immediate
                operand = CPU.addressing_modes.Immediate();
                CPU.instruction_set.LDX(operand);
                break;
            case 0xAE: // LDX nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.LDX(operand);
                break;
            case 0xA6: // LDX n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.LDX(operand);
                break;
            case 0xBE: // LDX nn,Y -- Absolute Y
                operand = CPU.addressing_modes.AbsoluteY();
                CPU.instruction_set.LDX(operand);
                break;
            case 0xB6: // LDX n,Y -- Zero Page Y
                operand = CPU.addressing_modes.ZeroPageY();
                CPU.instruction_set.LDX(operand);
                break;

            case 0xA0: // LDY #n -- Immediate
                operand = CPU.addressing_modes.Immediate();
                CPU.instruction_set.LDY(operand);
                break;
            case 0xAC: // LDY nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.LDY(operand);
                break;
            case 0xA4: // LDY n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.LDY(operand);
                break;
            case 0xB4: // LDY n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.LDY(operand);
                break;
            case 0xBC: // LDY nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.LDY(operand);
                break;

            case 0x4E: // LSR nn -- Absolute
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.LSR(operand);
                break;
            case 0x46: // LSR n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.LSR(operand);
                break;
            case 0x4A: // LSR A -- Accumulator
                operand = CPU.A;
                CPU.instruction_set.LSR_A();
                break;
            case 0x56: // LSR n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.LSR(operand);
                break;
            case 0x5E: // LSR nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.LSR(operand);
                break;

            case 0xEA: // NOP -- None
                CPU.instruction_set.NOP();
                break;

            case 0x09: // ORA #n -- Immediate
                operand = CPU.addressing_modes.Immediate();
                CPU.instruction_set.LSR(operand);
                break;
            case 0x0D: // ORA nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.LSR(operand);
                break;
            case 0x05: // ORA n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.LSR(operand);
                break;
            case 0x01: // ORA (n,X) -- Ind X
                operand = CPU.addressing_modes.IndX();
                CPU.instruction_set.LSR(operand);
                break;
            case 0x11: // ORA (n),Y -- Ind Y
                operand = CPU.addressing_modes.IndY();
                CPU.instruction_set.LSR(operand);
                break;
            case 0x15: // ORA n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.LSR(operand);
                break;
            case 0x1D: // ORA nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.LSR(operand);
                break;
            case 0x19: // ORA nn,Y -- Absolute Y
                operand = CPU.addressing_modes.AbsoluteY();
                CPU.instruction_set.LSR(operand);
                break;

            case 0x48: // PHA -- None
                CPU.instruction_set.PHA();
                break;
            case 0x08: // PHP -- None
                CPU.instruction_set.PHP();
                break;
            case 0x68: // PLA -- None
                CPU.instruction_set.PLA();
                break;
            case 0x28: // PLP -- None
                CPU.instruction_set.PLP();
                break;

            case 0x2E: // ROL nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.ROL(operand);
                break;
            case 0x26: // ROL n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.ROL(operand);
                break;
            case 0x2A: // ROL A -- Accumulator
                operand = CPU.A;
                CPU.instruction_set.ROL_A();
                break;
            case 0x36: // ROL n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.ROL(operand);
                break;
            case 0x3E: // ROL nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.ROL(operand);
                break;

            case 0x6E: // ROR nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.ROL(operand);
                break;
            case 0x66: // ROR n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.ROL(operand);
                break;
            case 0x6A: // ROR A -- Accumulator
                CPU.instruction_set.ROL_A(operand);
                break;
            case 0x76: // ROR n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.ROL(operand);
                break;
            case 0x7E: // ROR nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.ROL(operand);
                break;

            case 0x40: // RTI -- None
                CPU.instruction_set.RTI();
                break;
            case 0x60: // RTS -- None
                CPU.instruction_set.RTS();
                break;

            case 0xE9: // SBC #n -- Immediate
                operand = CPU.addressing_modes.Immediate();
                CPU.instruction_set.SBC(operand);
                break;
            case 0xED: // SBC nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.SBC(operand);
                break;
            case 0xE5: // SBC n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.SBC(operand);
                break;
            case 0xE1: // SBC (n,X) -- Ind X
                operand = CPU.addressing_modes.IndX();
                CPU.instruction_set.SBC(operand);
                break;
            case 0xF1: // SBC (n),Y -- Ind Y
                operand = CPU.addressing_modes.IndY();
                CPU.instruction_set.SBC(operand);
                break;
            case 0xF5: // SBC n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.SBC(operand);
                break;
            case 0xFD: // SBC nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.SBC(operand);
                break;
            case 0xF9: // SBC nn,Y -- Absolute Y
                operand = CPU.addressing_modes.AbsoluteY();
                CPU.instruction_set.SBC(operand);
                break;

            case 0x38: // SEC -- None
                CPU.instruction_set.SEC()
                break;
            case 0xF8: // SED -- None
                CPU.instruction_set.SED()
                break;
            case 0x78: // SEI -- None
                CPU.instruction_set.SEI()
                break;

            case 0x8D: // STA nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.STA(operand);
                break;
            case 0x85: // STA n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.STA(operand);
                break;
            case 0x81: // STA (n,X) -- Ind X
                operand = CPU.addressing_modes.IndX();
                CPU.instruction_set.STA(operand);
                break;
            case 0x91: // STA (n),Y -- Ind Y
                operand = CPU.addressing_modes.IndY();
                CPU.instruction_set.STA(operand);
                break;
            case 0x95: // STA n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.STA(operand);
                break;
            case 0x9D: // STA nn,X -- Absolute X
                operand = CPU.addressing_modes.AbsoluteX();
                CPU.instruction_set.STA(operand);
                break;
            case 0x99: // STA nn,Y -- Absolute Y
                operand = CPU.addressing_modes.AbsoluteY();
                CPU.instruction_set.STA(operand);
                break;
                
            case 0x8E: // STX nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.STX(operand);
                break;
            case 0x86: // STX n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.STX(operand);
                break;
            case 0x96: // STX n,Y -- Zero Page Y
                operand = CPU.addressing_modes.ZeroPageY();
                CPU.instruction_set.STX(operand);
                break;

            case 0x8C: // STY nn -- Absolute
                operand = CPU.addressing_modes.Absolute();
                CPU.instruction_set.STY(operand);
                break;
            case 0x84: // STY n -- Zero Page
                operand = CPU.addressing_modes.ZeroPage();
                CPU.instruction_set.STY(operand);
                break;
            case 0x94: // STY n,X -- Zero Page X
                operand = CPU.addressing_modes.ZeroPageX();
                CPU.instruction_set.STY(operand);
                break;

            case 0xAA: // TAX -- None
                CPU.instruction_set.TAX();
                break;
            case 0xA8: // TAY -- None
                CPU.instruction_set.TAY();
                break;
            case 0xBA: // TSX -- None
                CPU.instruction_set.TSX();
                break;
            case 0x8A: // TXA -- None
                CPU.instruction_set.TXA();
                break;
            case 0x9A: // TXS -- None
                CPU.instruction_set.TXS();
                break;
            case 0x98: // TYA -- None
                CPU.instruction_set.TYA();
                break;

            default:
                console.log("[UNRECOGNIZED]");
                break;
        }
    },
}

const NES_COLOR_PALETTE = [
    [84, 84, 84], [0, 30, 116], [8, 16, 144], [48, 0, 136], [68, 0, 100], [92, 0, 48], [84, 4, 0], [60, 24, 0],
    [32, 42, 0], [8, 58, 0], [0, 64, 0], [0, 60, 0], [0, 50, 60], [0, 0, 0], [0, 0, 0], [0, 0, 0],
    [152, 150, 152], [8, 76, 196], [48, 50, 236], [92, 30, 228], [136, 20, 176], [160, 20, 100], [152, 34, 32], [120, 60, 0],
    [84, 90, 0], [40, 114, 0], [8, 124, 0], [0, 118, 40], [0, 102, 120], [0, 0, 0], [0, 0, 0], [0, 0, 0],
    [236, 238, 236], [76, 154, 236], [120, 124, 236], [176, 98, 236], [228, 84, 236], [236, 88, 180], [236, 106, 100], [212, 136, 32],
    [160, 170, 0], [116, 196, 0], [76, 208, 32], [56, 204, 108], [56, 180, 204], [60, 60, 60], [0, 0, 0], [0, 0, 0],
    [236, 238, 236], [168, 204, 236], [188, 188, 236], [212, 178, 236], [236, 174, 236], [236, 174, 212], [236, 180, 176], [228, 196, 144],
    [204, 210, 120], [180, 222, 120], [168, 226, 144], [152, 226, 180], [160, 214, 228], [160, 162, 160], [0, 0, 0], [0, 0, 0]
];

const PPU = {
    // PPU Registers (simplified)
    ctrl: 0x00,
    mask: 0x00,
    status: 0x00,
    oamAddr: 0x00,
    oamData: 0x00,
    scroll: 0x00,
    addr: 0x00,
    data: 0x00,

    // Current scanline being rendered
    currentScanline: 0,

    // Functions to simulate PPU behavior
    reset: function() {
        this.ctrl = 0x00;
        this.mask = 0x00;
        this.status = 0x00;
        this.oamAddr = 0x00;
        this.oamData = 0x00;
        this.scroll = 0x00;
        this.addr = 0x00;
        this.data = 0x00;
        this.currentScanline = 0;
    },

    writeRegister: function(address, value) {
        switch (address) {
            case 0x2000: // PPUCTRL
                this.ctrl = value;
                // Implement logic for NMI, pattern table addresses, etc.
                break;

            case 0x2001: // PPUMASK
                this.mask = value;
                // Implement logic for rendering controls
                break;

            case 0x2002: // PPUSTATUS - Read only
                // This register is read-only, writes have no effect
                break;

            case 0x2003: // OAMADDR
                this.oamAddr = value;
                // Set the address in OAM where data will be read/written
                break;

            case 0x2004: // OAMDATA
                this.oamData = value;
                // Write value to OAM at the address specified by oamAddr
                // Update oamAddr accordingly
                break;

            case 0x2005: // PPUSCROLL
                // Implement logic for updating scroll position
                this.scroll = value;
                break;

            case 0x2006: // PPUADDR
                // Implement logic for setting the address in VRAM for data access
                this.addr = value;
                break;

            case 0x2007: // PPUDATA
                // Write value to VRAM at the address specified by addr
                // Update addr accordingly
                this.data = value;
                break;

            case 0x4014: // OAMDMA
                // Implement OAM DMA transfer logic
                // Typically involves reading data from CPU memory and writing to OAM
                break;

            default:
                console.error("Write to an unrecognized PPU address:", address);
                break;
        }
    },

    readRegister: function(address) {
        switch (address) {
            case 0x2002: // PPUSTATUS
                const status = this.status;
                // Clear the VBlank flag and other necessary actions
                // ...
                return status;

            case 0x2004: // OAMDATA
                // Return data from OAM at the current address
                return this.oamData;

            case 0x2007: // PPUDATA
                // Return data from VRAM at the current address
                // ...
                return this.data;

            default:
                console.error("Read from an unrecognized PPU address:", address);
                return 0;
        }
    },

    renderScanline: function() {
        // Render a single scanline
        // Placeholder for rendering logic
        // console.log("Rendering scanline", this.currentScanline);
    },

    executeCycles: function(cycles) {
        // Simulate PPU cycles for each CPU cycle
        for (let i = 0; i < cycles; i++) {
            // Update PPU state per cycle
            // ...

            if (i % CYCLES_PER_SCANLINE === 0) {
                this.currentScanline++;
                this.renderScanline();
            }
        }
    },

    getPaletteColor: function(index) {
        return NES_COLOR_PALETTE[index];
    }
};

let count = 0;
// Function to execute a single CPU cycle
function executeCPUCycle() {
    CPU.decodeAndExecute();
    if (count > 2000000) {
        console.log(`A: 0x${CPU.A.toString(16)}, X: 0x${CPU.X.toString(16)}, Y: 0x${CPU.Y.toString(16)}, SP: 0x${CPU.SP.toString(16)}, PC: 0x${CPU.PC.toString(16)}`);
        console.log(`Flags: N:${CPU.Flags.NegativeFlag} V:${CPU.Flags.OverflowFlag} B:${CPU.Flags.BreakFlag} D:${CPU.Flags.DecimalModeFlag} I:${CPU.Flags.InterruptFlag} Z:${CPU.Flags.ZeroFlag} C:${CPU.Flags.CarryFlag}`);
        count = 0;
    }
    count++;
}

// Function to update FPS (Frames Per Second)
function updateFps() {
    const currentTime = performance.now();
    const deltaTime = currentTime - lastFpsUpdateTime;

    if (deltaTime >= 1000) {
        const fps = fpsCounter / (deltaTime / 1000);
        console.log(`FPS: ${fps.toFixed(2)}`);

        lastFpsUpdateTime = currentTime;
        fpsCounter = 0;
    }
}

// Function to emulate a frame
function emulateFrame(limitCycles = null) {
    const start = performance.now();
    let cpuCycles = 0;
    let ppuCycles = 0;

    while (cpuCycles < CYCLES_PER_FRAME) {
        executeCPUCycle();
        cpuCycles++;

        // For each CPU cycle, run three PPU cycles
        for (let i = 0; i < 3; i++) {
            PPU.executeCycles(1); // Execute one PPU cycle
            ppuCycles++;

            if (ppuCycles % PPU_CYCLES_PER_SCANLINE === 0) {
                // Here you can add any additional PPU related operations per scanline
            }
        }

        if (limitCycles !== null && cpuCycles >= limitCycles) {
            break;
        }
    }

    const end = performance.now();
    const frameDuration = end - start;

    frameCounter++;
    fpsCounter++;
    updateFps();

    const currentTime = performance.now();
    const actualFrameDuration = currentTime - lastFrameTime;
    lastFrameTime = currentTime;

    const frameDurationDifference = actualFrameDuration - TARGET_FRAME_DURATION;
    frameRateAdjustment -= frameDurationDifference * 0.7;
    frameRateAdjustment = Math.max(0, Math.min(frameRateAdjustment, 100));

    setTimeout(() => emulateFrame(limitCycles), frameRateAdjustment);
}

function loadRom(romPath) {
    try {
        const romBuffer = fs.readFileSync(romPath);
        
        // Validate NES ROM header (first 4 bytes should be 'NES<EOF>')
        if (romBuffer[0] !== 0x4E || romBuffer[1] !== 0x45 || romBuffer[2] !== 0x53 || romBuffer[3] !== 0x1A) {
            console.error("Invalid NES ROM file.");
            return;
        }

        // Get the number of 16KB PRG ROM banks (byte 4 of the header)
        const prgBanks = romBuffer[4];
        const prgRomSize = 16384 * prgBanks; // 16KB per bank

        // Load the PRG ROM into the NES's memory (usually starts at 0x8000)
        let cpuMemoryAddress = 0x8000;
        for (let i = 16; i < 16 + prgRomSize; i++, cpuMemoryAddress++) {
            if (cpuMemoryAddress < 0x8000 || cpuMemoryAddress >= 0x10000) {
                break; // Only load into the addressable range
            }
            Memory.write(cpuMemoryAddress, romBuffer[i]);
        }

        // Reset CPU
        CPU.reset();
    } catch (error) {
        console.error("Error reading ROM file:", error.message);
    }
}

function test_program() {
    // Loading a test program into memory
    Memory.write(0x0000, 0xA9); // LDA (Immediate)
    Memory.write(0x0001, 0x05); // Operand (5)
    Memory.write(0x0002, 0xE9); // SBC (Immediate)
    Memory.write(0x0003, 0x03); // Operand (3)

    // Set the program counter to the start of the test program
    CPU.PC = 0x0000;

    for (let i = 0; i < 5; i++) { // Execute five instructions for this test
        CPU.decodeAndExecute();
    }

    // Check the state of the CPU
    console.log("Accumulator:", CPU.A); // Expected: 2 (5 - 3)
    console.log("Zero Flag:", CPU.Flags.ZeroFlag); // Expected: false
    console.log("Negative Flag:", CPU.Flags.NegativeFlag); // Expected: false
    console.log("Carry Flag:", CPU.Flags.CarryFlag); // Expected: true
}

function main(debug) {
    if (debug) {
        test_program();
    } else {
        const romPath = process.argv[2];
        if (!romPath) {
            console.error("No ROM path specified.");
            process.exit(1);
        }
        loadRom(romPath);
        emulateFrame();
    }
}

main(false);